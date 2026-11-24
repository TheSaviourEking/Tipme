import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { and, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issues,
  providerSplitChecks,
  type IssueSubject,
  type ProviderSplitReading,
} from '../schema.js';
import { balanceIn, businessBalanceIn } from './balance.js';
import { guarded, safeError } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';
import type { MoneyOwner } from './owner.js';
import {
  drainOrder,
  ownerProviderSet,
  type NamedProvider,
  type PayoutProviderSet,
} from './payout-providers.js';
import {
  balanceReferenceAt,
  committedAtProvider,
  type PayoutReader,
  type ProviderReadFailureLog,
} from './payouts.js';

/**
 * Per-provider balances, the daily split check (spec §5a, §7, P12). Each split owner's ledger
 * available is compared with Σ (partner balance − queued) across their providers. Withdrawals are
 * always capped by the ledger, so a gap never overpays anyone: it is for staff to investigate.
 */

/** Providers holding less than the ledger by more than this (₦100) opens `provider_split_short`. */
export const SPLIT_SHORT_THRESHOLD_MINOR = 10_000n;
/** At most this many owners a run (P12): every 15 minutes, so the reads spread across the day. */
export const SPLIT_CHECK_BATCH = 20;
/** An owner is due again once their latest check is this old. */
const CHECK_EVERY_MS = 24 * 3_600_000;
/** Check rows are kept this long (P12). */
const KEEP_MS = 90 * 24 * 3_600_000;
/** The most owner ids an issue note lists; the rest are counted. */
const NOTE_IDS = 50;

export type SplitOutcome = 'ok' | 'short' | 'over' | 'partial';

const naira = (minor: bigint): string => {
  const sign = minor < 0n ? '−' : '';
  const value = minor < 0n ? -minor : minor;
  const kobo = value % 100n;
  const whole = new Intl.NumberFormat('en').format(value / 100n);
  return `${sign}₦${whole}${kobo === 0n ? '' : `.${String(kobo).padStart(2, '0')}`}`;
};

const ownerId = (owner: MoneyOwner): string =>
  'businessId' in owner ? owner.businessId : owner.profileId;

const ownerWords = (owner: MoneyOwner): string =>
  'businessId' in owner
    ? `business ${owner.businessId}`
    : `profile ${owner.profileId}`;

/** A list of SQL values, for `IN (...)`. Never called with none. */
const listOf = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/**
 * The owners due a check, oldest check first (never checked first): those with an account
 * reference at, or a successful tip through, a withdraw-only provider, so their provider set
 * (`ownerProviderSet`) has two or more providers, and whose latest check is missing or at least 24 h
 * old. Reads TipMe's own records only.
 */
export async function splitOwnersDue(
  db: Database,
  set: PayoutProviderSet<NamedProvider>,
  input: { now: Date; limit: number },
): Promise<MoneyOwner[]> {
  const active = recordedProviderName(set.active.name);
  // Config refuses a withdraw-only provider recorded as the active one; never treat it as another.
  const old = set.withdrawOnly.filter(
    (provider) => recordedProviderName(provider.name) !== active,
  );
  if (!old.length || input.limit <= 0) return [];
  const names = listOf([
    ...new Set(old.map((provider) => recordedProviderName(provider.name))),
  ]);
  // As `holdsAt`: an account counts at the provider and environment it was opened in.
  const accounts = old.flatMap((provider) => {
    const environment = bachsEnvironment(provider.name);
    return environment
      ? [sql`(${recordedProviderName(provider.name)}, ${environment})`]
      : [];
  });
  const accountOwners = accounts.length
    ? sql`UNION
          SELECT profile_id, business_id FROM payment_accounts
           WHERE provider_account_reference IS NOT NULL
             AND (provider, environment::text) IN (${sql.join(accounts, sql`, `)})`
    : sql``;
  const cutoff = new Date(input.now.getTime() - CHECK_EVERY_MS).toISOString();
  const result = await guarded(() =>
    db.execute<{ profile_id: string | null; business_id: string | null }>(sql`
      WITH owners AS (
        SELECT t.profile_id, NULL::uuid AS business_id FROM tips t
          JOIN payment_attempts a ON a.intent_id = t.intent_id
         WHERE t.status = 'SUCCEEDED' AND a.status = 'VERIFIED_SUCCEEDED'
           AND a.provider IN (${names}) AND t.profile_id IS NOT NULL
        UNION
        SELECT NULL::uuid, s.business_id FROM tip_business_shares s
          JOIN tips t ON t.id = s.tip_id
          JOIN payment_attempts a ON a.intent_id = t.intent_id
         WHERE t.status = 'SUCCEEDED' AND a.status = 'VERIFIED_SUCCEEDED'
           AND a.provider IN (${names})
        ${accountOwners}
      )
      SELECT o.profile_id, o.business_id FROM owners o
       CROSS JOIN LATERAL (SELECT COALESCE(
         (SELECT max(c.checked_at) FROM provider_split_checks c WHERE c.profile_id = o.profile_id),
         (SELECT max(c.checked_at) FROM provider_split_checks c WHERE c.business_id = o.business_id)
       ) AS checked_at) latest
       WHERE latest.checked_at IS NULL OR latest.checked_at <= ${cutoff}::timestamptz
       ORDER BY latest.checked_at ASC NULLS FIRST, o.profile_id, o.business_id
       LIMIT ${input.limit}`),
  );
  return result.rows.map((row) =>
    row.profile_id !== null
      ? { profileId: row.profile_id }
      : { businessId: row.business_id! },
  );
}

/** The ledger's available for the owner, less payouts in flight; may be below zero (Q8). */
async function ledgerAvailable(
  db: Database,
  owner: MoneyOwner,
): Promise<bigint> {
  return 'businessId' in owner
    ? (await businessBalanceIn(db, owner.businessId)).availableMinor
    : (await balanceIn(db, owner.profileId)).availableMinor;
}

/** One reading of an owner's providers and ledger, and what it says. */
type SplitMeasure = {
  ledgerMinor: bigint;
  readings: (ProviderSplitReading & { held: bigint | null; queued: bigint })[];
  outcome: SplitOutcome;
  /** Σ (held − queued) and ledger − that; both 0 when a read failed. */
  heldMinor: bigint;
  gapMinor: bigint;
};

/**
 * Reads each provider in the owner's set once, then TipMe's own figures. The providers come first,
 * so a payout started in between shows as over (harmless), never short.
 */
async function measureSplit(
  db: Database,
  owner: MoneyOwner,
  providers: readonly PayoutReader[],
  onReadFailure?: ProviderReadFailureLog,
): Promise<SplitMeasure> {
  const read: { provider: PayoutReader; availableMinor: bigint | null }[] = [];
  for (const provider of providers) {
    const reference = await balanceReferenceAt(db, owner, provider);
    // No account there: that provider holds nothing of theirs, and is not asked.
    if (reference === null) {
      read.push({ provider, availableMinor: 0n });
      continue;
    }
    try {
      const { availableMinor } = await provider.payoutBalance(reference, 'NGN');
      read.push({ provider, availableMinor });
    } catch (error) {
      onReadFailure?.(safeError(error), provider.name);
      read.push({ provider, availableMinor: null });
    }
  }
  const ledgerMinor = await guarded(() => ledgerAvailable(db, owner));
  const readings: SplitMeasure['readings'] = [];
  for (const { provider, availableMinor } of read) {
    const stored = recordedProviderName(provider.name);
    const queued = await guarded(() => committedAtProvider(db, owner, stored));
    readings.push({
      provider: stored,
      availableMinor:
        availableMinor === null ? null : availableMinor.toString(),
      queuedMinor: queued.toString(),
      held: availableMinor,
      queued,
    });
  }
  if (readings.some((reading) => reading.held === null))
    return {
      ledgerMinor,
      readings,
      outcome: 'partial',
      heldMinor: 0n,
      gapMinor: 0n,
    };
  const heldMinor = readings.reduce(
    (sum, reading) => sum + reading.held! - reading.queued,
    0n,
  );
  const gapMinor = ledgerMinor - heldMinor;
  return {
    ledgerMinor,
    readings,
    outcome:
      gapMinor > SPLIT_SHORT_THRESHOLD_MINOR
        ? 'short'
        : gapMinor < 0n
          ? 'over'
          : 'ok',
    heldMinor,
    gapMinor,
  };
}

/**
 * One open issue per cause at a time, each spell under its own key (`<prefix><id>`), so an issue
 * staff resolved never swallows the next spell (as `openOnce` in collect-transfers.ts). The
 * advisory lock keeps two runs from opening the same spell twice. True when it opened one.
 */
async function openSpell(
  tx: Tx,
  input: {
    prefix: string;
    kind: 'provider_split_short' | 'provider_unconnected_money';
    subject: IssueSubject;
    note: string;
    now: Date;
  },
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`provider_split_issue:${input.prefix}`}::text))`,
  );
  const [open] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.status, 'open'),
        sql`starts_with(${issues.dedupeKey}, ${input.prefix})`,
      ),
    )
    .limit(1);
  if (open) return false;
  const { opened } = await openIssue(tx, {
    dedupeKey: `${input.prefix}${newId()}`,
    kind: input.kind,
    subject: input.subject,
    note: input.note,
    now: input.now,
  });
  return opened;
}

/**
 * One owner's check (spec §7): reads each provider in their set, records one row, and opens
 * `provider_split_short` when the providers hold less than the ledger by more than ₦100. Holding
 * more is `over` (informational: common while a reversal is in flight). A failed read is
 * `partial`, with no issue: a figure missing one provider says nothing either way.
 *
 * Short is read once more (providers and ledger) before an issue is opened, so a one-off dip at a
 * provider, or a tip confirmed between the two reads, opens nothing. The row keeps the first
 * reading; the issue's note gives the second. A short owner can so read each provider twice.
 */
export async function checkProviderSplit(
  db: Database,
  owner: MoneyOwner,
  set: PayoutProviderSet,
  input: { now: Date; onReadFailure?: ProviderReadFailureLog },
): Promise<{ outcome: SplitOutcome }> {
  const { providers } = await guarded(() => ownerProviderSet(db, owner, set));
  const first = await measureSplit(db, owner, providers, input.onReadFailure);
  const confirmed =
    first.outcome === 'short'
      ? await measureSplit(db, owner, providers, input.onReadFailure)
      : null;
  await guarded(() =>
    db.transaction(async (tx) => {
      await tx.insert(providerSplitChecks).values({
        id: newId(),
        profileId: 'profileId' in owner ? owner.profileId : null,
        businessId: 'businessId' in owner ? owner.businessId : null,
        checkedAt: input.now,
        ledgerMinor: first.ledgerMinor,
        providers: first.readings.map(
          ({ provider, availableMinor, queuedMinor }) => ({
            provider,
            availableMinor,
            queuedMinor,
          }),
        ),
        outcome: first.outcome,
      });
      if (confirmed?.outcome !== 'short') return;
      // One open issue per owner: a later short check adds its row, not a second issue.
      await openSpell(tx, {
        prefix: `provider_split_short.${ownerId(owner)}.`,
        kind: 'provider_split_short',
        subject:
          'businessId' in owner
            ? { businessId: owner.businessId }
            : { profileId: owner.profileId },
        now: input.now,
        note: `Owner: ${ownerWords(owner)}. Ledger available ${naira(confirmed.ledgerMinor)}. ${confirmed.readings
          .map(
            (reading) =>
              `${reading.provider}: ${naira(reading.held!)} held, ${naira(reading.queued)} queued.`,
          )
          .join(
            ' ',
          )} Together they hold ${naira(confirmed.heldMinor)} after what is queued: ${naira(confirmed.gapMinor)} short.`,
      });
    }),
  );
  return { outcome: first.outcome };
}

/**
 * A provider no longer configured that still holds owners' money (spec §7): one
 * `provider_unconnected_money` issue per provider, listing the owners whose ledger still has money
 * and who were tipped through it, and any withdrawal still REQUESTED there (Review Focus 5: the
 * worker never starts it through another provider). A provider with an open issue is not looked at
 * again; once staff resolve it, money still there opens a new one. Returns how many it opened.
 */
export async function flagUnconnectedMoney(
  db: Database,
  set: PayoutProviderSet<NamedProvider>,
  now: Date,
): Promise<number> {
  const configured = listOf([
    ...new Set(
      drainOrder(set).map((provider) => recordedProviderName(provider.name)),
    ),
  ]);
  const found = await guarded(() =>
    db.execute<{ provider: string }>(sql`
      SELECT p.provider FROM (
        SELECT DISTINCT a.provider FROM payment_attempts a
          JOIN tips t ON t.intent_id = a.intent_id
         WHERE a.status = 'VERIFIED_SUCCEEDED' AND t.status = 'SUCCEEDED'
           AND a.provider IS NOT NULL AND a.provider NOT IN (${configured})
        UNION
        SELECT DISTINCT provider FROM payouts
         WHERE status = 'REQUESTED' AND provider IS NOT NULL AND provider NOT IN (${configured})
      ) p
       WHERE NOT EXISTS (SELECT 1 FROM issues i
                          WHERE i.status = 'open'
                            AND starts_with(i.dedupe_key, 'provider_unconnected_money.' || p.provider || '.'))
       ORDER BY p.provider`),
  );
  let opened = 0;
  for (const { provider } of found.rows) {
    const tipped = await guarded(() =>
      db.execute<{ profile_id: string | null; business_id: string | null }>(sql`
        SELECT t.profile_id, NULL::uuid AS business_id FROM tips t
          JOIN payment_attempts a ON a.intent_id = t.intent_id
         WHERE t.status = 'SUCCEEDED' AND a.status = 'VERIFIED_SUCCEEDED'
           AND a.provider = ${provider} AND t.profile_id IS NOT NULL
        UNION
        SELECT NULL::uuid, s.business_id FROM tip_business_shares s
          JOIN tips t ON t.id = s.tip_id
          JOIN payment_attempts a ON a.intent_id = t.intent_id
         WHERE t.status = 'SUCCEEDED' AND a.status = 'VERIFIED_SUCCEEDED'
           AND a.provider = ${provider}
         ORDER BY 1, 2`),
    );
    const requested = await guarded(() =>
      db.execute<{
        id: string;
        profile_id: string | null;
        business_id: string | null;
      }>(sql`
        SELECT id, profile_id, business_id FROM payouts
         WHERE provider = ${provider} AND status = 'REQUESTED'
         ORDER BY created_at, id`),
    );
    const owners = new Map<string, MoneyOwner>();
    for (const row of tipped.rows) {
      const owner: MoneyOwner =
        row.profile_id !== null
          ? { profileId: row.profile_id }
          : { businessId: row.business_id! };
      if ((await guarded(() => ledgerAvailable(db, owner))) > 0n)
        owners.set(ownerWords(owner), owner);
    }
    // Money reserved by a payout still waiting there is theirs too, whatever the ledger shows now.
    for (const row of requested.rows) {
      const owner: MoneyOwner =
        row.profile_id !== null
          ? { profileId: row.profile_id }
          : { businessId: row.business_id! };
      owners.set(ownerWords(owner), owner);
    }
    if (!owners.size) continue;
    const listed = (ids: string[]) =>
      ids.length > NOTE_IDS
        ? `${ids.slice(0, NOTE_IDS).join(', ')} and ${ids.length - NOTE_IDS} more`
        : ids.join(', ');
    const payoutIds = requested.rows.map((row) => row.id);
    const result = await guarded(() =>
      db.transaction((tx) =>
        openSpell(tx, {
          prefix: `provider_unconnected_money.${provider}.`,
          kind: 'provider_unconnected_money',
          subject: {},
          now,
          note: `Provider: ${provider}. Owners (${owners.size}): ${listed([...owners.keys()])}. Withdrawals still requested there: ${payoutIds.length ? listed(payoutIds) : 'none'}.`,
        }),
      ),
    );
    if (result) opened += 1;
  }
  return opened;
}

/** Deletes check rows older than 90 days (P12). Returns how many. */
export async function purgeSplitChecks(
  db: Database,
  now: Date,
): Promise<number> {
  const deleted = await guarded(() =>
    db
      .delete(providerSplitChecks)
      .where(
        lt(providerSplitChecks.checkedAt, new Date(now.getTime() - KEEP_MS)),
      )
      .returning({ id: providerSplitChecks.id }),
  );
  return deleted.length;
}
