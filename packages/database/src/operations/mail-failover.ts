import type { MailHealth, MailProviderName } from '@tipme/mail';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { providerSettings } from '../schema.js';
import { recordAudit } from './audit.js';

/*
 * Automatic failover between mail providers (owner, 23 Nov 2026): what the database knows. The
 * breaker itself is in Redis (@tipme/mail health.ts); here are the ops "fixed" choice, the
 * provider that sent someone's previous code (rule c), and the unused-codes signal (b), which reads
 * one-time codes and when they were used.
 */

/**
 * The emails that carry a one-time code (issueEmailCode): each has a definite "used" moment, the
 * code's consumed_at, so an unused one says something about delivery. Their dedupe key is
 * `<type>.<email_codes.id>`.
 */
export const ONE_TIME_CODE_MAIL_TYPES: ReadonlySet<string> = new Set([
  'sign_in_code',
  'email_change_code',
  'recovery_email_code',
  'recovery_change_code',
  'recovery_code',
  'recovery_new_email_code',
  'payout_destination_code',
]);

const CODE_TYPES = [...ONE_TIME_CODE_MAIL_TYPES];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The email_codes row behind a code email, from its dedupe key; null for any other mail. */
export function codeIdOf(mail: {
  type: string;
  dedupeKey: string;
}): string | null {
  if (!ONE_TIME_CODE_MAIL_TYPES.has(mail.type)) return null;
  const id = mail.dedupeKey.slice(mail.type.length + 1);
  return mail.dedupeKey.startsWith(`${mail.type}.`) && UUID.test(id)
    ? id
    : null;
}

/** Staff fixed the active mail provider in ops: no automatic switching. */
export async function mailFailoverFixed(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ detail: providerSettings.detail })
    .from(providerSettings)
    .where(eq(providerSettings.kind, 'mail'));
  return (row?.detail as { fixed?: unknown } | undefined)?.fixed === true;
}

/**
 * Fixes the active provider (no automatic switching, e.g. during an investigation) or lets it
 * switch again. Kept in provider_settings.detail, so no migration; a switch keeps it.
 */
export function setMailFailoverFixed(
  db: Database,
  input: {
    staffUserId: string;
    fixed: boolean;
    reason: string;
    /** The server default, written as the active provider if staff never chose one. */
    fallback: MailProviderName;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const detail = sql`jsonb_build_object('fixed', ${input.fixed}::boolean)`;
    await tx
      .insert(providerSettings)
      .values({
        kind: 'mail',
        activeProvider: input.fallback,
        changedBy: input.staffUserId,
        changedAt: now,
        reason: input.reason,
        detail: { fixed: input.fixed },
      })
      .onConflictDoUpdate({
        target: providerSettings.kind,
        set: { detail: sql`${providerSettings.detail} || ${detail}` },
      });
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: input.fixed
        ? 'mail_provider.failover_fixed'
        : 'mail_provider.failover_automatic',
      permission: 'providers.manage',
      subjectType: 'mail_provider',
      subjectId: 'mail',
      reason: input.reason,
      now,
    });
  });
}

/** Staff cleared a provider's breaker by hand (Ops → Providers). */
export async function recordMailHealthCleared(
  db: Database,
  input: {
    staffUserId: string;
    provider: MailProviderName;
    reason: string;
    now?: Date;
  },
): Promise<void> {
  await recordAudit(db, {
    staffUserId: input.staffUserId,
    action: 'mail_provider.health_cleared',
    permission: 'providers.manage',
    subjectType: 'mail_provider',
    subjectId: input.provider,
    reason: input.reason,
    now: input.now ?? new Date(),
  });
}

/**
 * Rule (c): the provider that sent this address its previous code for the same purpose, when that
 * code was asked for within `windowMs` before this one. Null otherwise (or for any other mail).
 */
export async function previousCodeProvider(
  db: Database,
  mail: { type: string; dedupeKey: string },
  windowMs: number,
): Promise<MailProviderName | null> {
  const id = codeIdOf(mail);
  if (!id) return null;
  const keys = sql.join(
    CODE_TYPES.map((type) => sql`${type} || '.' || prev.id::text`),
    sql`, `,
  );
  const { rows } = await db.execute<{ provider: string }>(sql`
    SELECT m.provider
      FROM email_codes cur
      JOIN email_codes prev
        ON prev.email = cur.email AND prev.purpose = cur.purpose
       AND prev.created_at < cur.created_at
       AND prev.created_at >= cur.created_at - make_interval(secs => ${windowMs / 1000})
      JOIN mail_messages m ON m.dedupe_key IN (${keys})
     WHERE cur.id = ${id}::uuid AND m.provider IS NOT NULL AND m.sent_at IS NOT NULL
       -- Only someone still waiting is rescued: a used code was delivered.
       AND prev.consumed_at IS NULL
     ORDER BY prev.created_at DESC
     LIMIT 1`);
  return (rows[0]?.provider as MailProviderName | undefined) ?? null;
}

export interface CodeDeliverySettings {
  /** A code not used this long after it was sent counts as unused (180 s). */
  unusedAfterMs: number;
  /** The window the ratio is taken over (10 min). */
  windowMs: number;
  /** At least this many decided addresses before the ratio counts (5). */
  minSamples: number;
  /** This share of them using none of their codes trips the provider (0.6). */
  unusedRatio: number;
  /** Codes on trial after a codes trip (3). */
  trialCodes: number;
}

/** A trial nobody concluded in this long (slots lost to a dead worker) rests the provider again. */
const TRIAL_GIVE_UP_MS = 30 * 60_000;

/**
 * Codes sent through `provider` from `since` to `now`, and how they ended. A code is decided when
 * it was used within unusedAfter (used), when the same address asked for another code while it
 * was still valid (unused at once: a re-request), or when unusedAfter has passed (unused). Codes
 * still waiting are not counted, and a bounced or complained one is about the address, not the
 * provider. `samples` and `unused` count addresses (one is unused when none of its codes was
 * used in time); `unusedCodes` and `redeemed` count codes, for a trial (redeemed: used at all,
 * however late).
 */
export async function codeDeliveryStats(
  db: Database,
  input: {
    provider: MailProviderName;
    since: Date;
    now: Date;
    unusedAfterMs: number;
  },
): Promise<{
  samples: number;
  unused: number;
  unusedCodes: number;
  redeemed: number;
}> {
  const after = sql`make_interval(secs => ${input.unusedAfterMs / 1000})`;
  const types = sql.join(
    CODE_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const { rows } = await db.execute<{
    samples: number;
    unused: number;
    unused_codes: number;
    redeemed: number;
  }>(sql`
    WITH sent AS (
      SELECT c.email, m.sent_at, c.consumed_at,
             (c.consumed_at IS NOT NULL AND c.consumed_at <= m.sent_at + ${after}) AS used,
             (c.consumed_at IS NULL AND EXISTS (
               SELECT 1 FROM email_codes n
                WHERE n.email = c.email AND n.purpose = c.purpose
                  AND n.created_at > c.created_at AND n.created_at < c.expires_at
                  AND n.created_at <= ${input.now.toISOString()}::timestamptz)) AS superseded
        FROM mail_messages m
        JOIN email_codes c
          ON c.id = CASE WHEN substring(m.dedupe_key FROM length(m.type) + 2)
                              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN substring(m.dedupe_key FROM length(m.type) + 2)::uuid END
       WHERE m.type IN (${types})
         AND m.sent_at >= ${input.since.toISOString()}::timestamptz
         AND m.sent_at <= ${input.now.toISOString()}::timestamptz
         AND m.provider = ${input.provider}
         AND m.status NOT IN ('bounced', 'complained')
    ), decided AS (
      SELECT email, used, consumed_at,
             (used OR superseded
               OR sent_at <= ${input.now.toISOString()}::timestamptz - ${after}) AS decided
        FROM sent
    ), people AS (
      -- One address is one sample, so one person asking again and again (or a script using a few
      -- addresses) can't make up the minimum: used if any of its codes was used in time, decided
      -- once one was used or all of them are decided.
      SELECT bool_or(used) AS used, (bool_or(used) OR bool_and(decided)) AS decided
        FROM decided GROUP BY email
    )
    SELECT (SELECT count(*) FILTER (WHERE decided) FROM people)::int AS samples,
           (SELECT count(*) FILTER (WHERE decided AND NOT used) FROM people)::int AS unused,
           (SELECT count(*) FILTER (WHERE decided AND NOT used) FROM decided)::int AS unused_codes,
           (SELECT count(*) FILTER (WHERE consumed_at IS NOT NULL) FROM decided)::int AS redeemed`);
  const row = rows[0];
  return {
    samples: Number(row?.samples ?? 0),
    unused: Number(row?.unused ?? 0),
    unusedCodes: Number(row?.unused_codes ?? 0),
    redeemed: Number(row?.redeemed ?? 0),
  };
}

export type CodeDeliveryOutcome =
  'ok' | 'tripped' | 'restored' | 'rested_again' | 'waiting' | 'skipped';

/**
 * Signal (b), run by the worker every half minute: for each provider in the failover group,
 * - healthy: over the window (or since it last recovered, so old codes can't trip it again), at
 *   least minSamples decided addresses and at least unusedRatio of them unused rest it;
 * - on trial after a codes trip: a trial code used restores it; trialCodes unused (or a trial
 *   nobody concluded in 30 minutes) rest it again.
 * A provider resting, or on a probe trial after send failures, is left to the breaker. The sample
 * minimum and the ratio count addresses, so one person (or a few addresses) never trips it.
 */
export interface CodeDeliveryCheck {
  provider: MailProviderName;
  outcome: CodeDeliveryOutcome;
  samples: number;
  unused: number;
}

export async function checkCodeDelivery(
  db: Database,
  input: {
    health: MailHealth;
    providers: readonly MailProviderName[];
    now: Date;
    settings: CodeDeliverySettings;
  },
): Promise<CodeDeliveryCheck[]> {
  const { settings, now } = input;
  const views = await input.health.snapshot(input.providers);
  const out: CodeDeliveryCheck[] = [];
  for (const provider of input.providers) {
    const view = views.get(provider);
    if (!view) continue;
    if (view.state === 'healthy') {
      const windowStart = now.getTime() - settings.windowMs;
      const since = new Date(
        Math.max(windowStart, view.recoveredAt?.getTime() ?? 0),
      );
      const stats = await codeDeliveryStats(db, {
        provider,
        since,
        now,
        unusedAfterMs: settings.unusedAfterMs,
      });
      const trips =
        stats.samples >= settings.minSamples &&
        // A hair under the ratio, so 3 of 5 meets 0.6 despite floating point.
        stats.unused / stats.samples >= settings.unusedRatio - 1e-9;
      if (trips)
        await input.health.tripCodes(
          provider,
          `${stats.unused} of ${stats.samples} addresses' codes unused in ${Math.round(settings.windowMs / 60_000)} min`,
        );
      out.push({
        provider,
        outcome: trips ? 'tripped' : 'ok',
        samples: stats.samples,
        unused: stats.unused,
      });
      continue;
    }
    if (
      view.state !== 'trial' ||
      view.kind !== 'codes' ||
      !view.trialStartedAt
    ) {
      out.push({ provider, outcome: 'skipped', samples: 0, unused: 0 });
      continue;
    }
    const stats = await codeDeliveryStats(db, {
      provider,
      since: view.trialStartedAt,
      now,
      unusedAfterMs: settings.unusedAfterMs,
    });
    let outcome: CodeDeliveryOutcome = 'waiting';
    if (stats.redeemed > 0) {
      await input.health.restoreCodes(provider);
      outcome = 'restored';
    } else if (
      stats.unusedCodes >= settings.trialCodes ||
      now.getTime() - view.trialStartedAt.getTime() > TRIAL_GIVE_UP_MS
    ) {
      await input.health.tripCodes(
        provider,
        `${stats.unusedCodes} of ${settings.trialCodes} trial codes unused`,
      );
      outcome = 'rested_again';
    }
    out.push({
      provider,
      outcome,
      samples: stats.samples,
      unused: stats.unused,
    });
  }
  return out;
}
