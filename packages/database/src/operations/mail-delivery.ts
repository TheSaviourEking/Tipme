import {
  MAIL_TYPES,
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
  isPretendRecipient,
  mailProviderChain,
  renderMail,
  resolveMailProvider,
  sendFailureOf,
  type MailCategory,
  type MailHealth,
  type MailProvider,
  type MailProviderName,
  type OutgoingMail,
  senderAddress,
} from '@tipme/mail';
import { and, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  mailMessages,
  mailPreferences,
  mailSuppressions,
  profiles,
  users,
} from '../schema.js';
import {
  addressHmac,
  recordMailEvent,
  type MailSealing,
} from './mail-queue.js';
import { writePretendMessage } from './pretend-outbox.js';
import { openSecret, sealSecret } from './secret-box.js';
import { canUnsubscribe, unsubscribeToken } from './mail-preferences.js';
import {
  ONE_TIME_CODE_MAIL_TYPES,
  previousCodeProvider,
} from './mail-failover.js';

/** Waits before each retry; the sixth temporary failure fails the mail. */
export const MAIL_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000,
] as const;
const MAX_ATTEMPTS = MAIL_BACKOFF_MS.length + 1;
/**
 * After the provider says its sending allowance is used up (MailQuotaError: Brevo out of credits),
 * the mail waits this long and asks again, as many times as it takes, without using an attempt.
 */
export const MAIL_QUOTA_RETRY_MS = 3_600_000;
const STUCK_AFTER_MS = 2 * 60_000;
const CONTENT_KEPT_MS = 7 * 86_400_000;

export interface ClaimedMail {
  id: string;
  type: string;
  /** For a code email, `<type>.<email_codes.id>`: which code it carries. */
  dedupeKey: string;
  category: MailCategory;
  userId: string | null;
  to: string;
  data: unknown;
  pinnedProvider: MailProviderName | null;
  expiresAt: Date | null;
  attempts: number;
  /** This claim's time: every later write must match it, so a stalled worker can't overwrite. */
  claimedAt: Date;
}

/**
 * Claims due mail (codes someone is waiting for, then security, then oldest), marking it `sending` so concurrent workers
 * split the work. The claim commits before anything is sent.
 */
export async function claimDueMail(
  db: Database,
  sealing: MailSealing,
  input: { now: Date; limit: number },
): Promise<ClaimedMail[]> {
  const rows = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.status, 'queued'),
          lte(mailMessages.nextAttemptAt, input.now),
        ),
      )
      .orderBy(mailMessages.priority, mailMessages.nextAttemptAt)
      .limit(input.limit)
      .for('update', { skipLocked: true });
    if (due.length > 0)
      await tx
        .update(mailMessages)
        .set({ status: 'sending', claimedAt: input.now })
        .where(
          inArray(
            mailMessages.id,
            due.map((row) => row.id),
          ),
        );
    return due;
  });
  const claimed: ClaimedMail[] = [];
  for (const row of rows) {
    let to: string;
    let data: unknown;
    try {
      to = row.toSealed ? openSecret(sealing.key, row.toSealed) : '';
      data = row.dataSealed
        ? (JSON.parse(openSecret(sealing.key, row.dataSealed)) as unknown)
        : null;
    } catch {
      // One unreadable row fails on its own; it never holds back the rest of the batch.
      await recordMailFailure(db, {
        id: row.id,
        type: row.type,
        category: row.category as MailCategory,
        provider: null,
        code: 'unreadable',
        permanent: true,
        attempts: row.attempts,
        claimedAt: input.now,
        now: input.now,
      });
      continue;
    }
    claimed.push({
      id: row.id,
      type: row.type,
      dedupeKey: row.dedupeKey,
      category: row.category as MailCategory,
      userId: row.userId,
      to,
      data,
      pinnedProvider: row.pinnedProvider as MailProviderName | null,
      expiresAt: row.expiresAt,
      attempts: row.attempts,
      claimedAt: input.now,
    });
  }
  return claimed;
}

/** Only the worker holding this exact claim may record its outcome. */
const ownsClaim = (id: string, claimedAt: Date) =>
  and(
    eq(mailMessages.id, id),
    eq(mailMessages.status, 'sending'),
    eq(mailMessages.claimedAt, claimedAt),
  );

/** Checks made at send time, so a change after queueing still counts. */
export async function mailGate(
  db: Database,
  sealing: MailSealing,
  mail: ClaimedMail,
  now: Date,
): Promise<'send' | 'expired' | 'suppressed' | 'skipped_preference'> {
  if (mail.expiresAt && mail.expiresAt <= now) return 'expired';
  const [suppressed] = await db
    .select({ reason: mailSuppressions.reason })
    .from(mailSuppressions)
    .where(eq(mailSuppressions.addressHmac, addressHmac(sealing, mail.to)));
  // A provider test is about the provider, so only an address that doesn't exist blocks it.
  if (
    suppressed &&
    (mail.type !== 'provider_test' || suppressed.reason === 'hard_bounce')
  )
    return 'suppressed';
  if (!mail.userId) return 'send';
  // A deleted account gets security mail only: its goodbye is the last email it gets.
  if (mail.category !== 'security') {
    const [account] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, mail.userId));
    if (account?.deletedAt) return 'skipped_preference';
  }
  const type = MAIL_TYPES[mail.type];
  if (type?.preference) {
    const column = {
      notify_tip_emails: profiles.notifyTipEmails,
      notify_weekly_reports: profiles.notifyWeeklyReports,
      notify_milestones: profiles.notifyMilestones,
    }[type.preference];
    const [profile] = await db
      .select({ wants: column })
      .from(profiles)
      .where(eq(profiles.userId, mail.userId));
    if (profile && !profile.wants) return 'skipped_preference';
  }
  // The guides switch covers engagement mail with no switch of its own. Marketing needs its own
  // opt-in, and is held back too by the guides and news switch being off (announcements, 14 Nov 2026).
  if (
    (mail.category === 'engagement' && !type?.preference) ||
    mail.category === 'marketing'
  ) {
    const [prefs] = await db
      .select()
      .from(mailPreferences)
      .where(eq(mailPreferences.userId, mail.userId));
    if (mail.category === 'engagement' && prefs && !prefs.engagement)
      return 'skipped_preference';
    if (
      mail.category === 'marketing' &&
      (!prefs?.marketing || prefs.engagement === false)
    )
      return 'skipped_preference';
  }
  return 'send';
}

const STATUS_FOR_GATE = {
  expired: 'expired',
  suppressed: 'suppressed',
  skipped_preference: 'skipped',
} as const;

async function finishWithoutSending(
  db: Database,
  mail: ClaimedMail,
  outcome: keyof typeof STATUS_FOR_GATE,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(mailMessages)
      .set({ status: STATUS_FOR_GATE[outcome], finalAt: now, claimedAt: null })
      .where(ownsClaim(mail.id, mail.claimedAt))
      .returning({ id: mailMessages.id });
    if (updated.length === 0) return;
    await recordMailEvent(tx, {
      messageId: mail.id,
      kind: outcome,
      occurredAt: now,
      type: mail.type,
      category: mail.category,
    });
  });
}

export async function recordMailSent(
  db: Database,
  input: {
    id: string;
    type: string;
    category: MailCategory;
    provider: MailProviderName;
    providerMessageId: string;
    snapshot: object | null;
    sealing: MailSealing;
    claimedAt: Date;
    now: Date;
  },
): Promise<'sent' | 'stale'> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(mailMessages)
      .set({
        // A bounce or complaint may have arrived first: it stays, and the send is still recorded.
        status: sql`CASE WHEN ${mailMessages.status} = 'sending' THEN 'sent' ELSE ${mailMessages.status} END`,
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        renderedSealed: input.snapshot
          ? sealSecret(input.sealing.key, JSON.stringify(input.snapshot))
          : null,
        attempts: sql`${mailMessages.attempts} + 1`,
        sentAt: input.now,
        finalAt: sql`coalesce(${mailMessages.finalAt}, ${input.now.toISOString()}::timestamptz)`,
        claimedAt: null,
        lastError: null,
      })
      .where(
        and(
          eq(mailMessages.id, input.id),
          inArray(mailMessages.status, ['sending', 'bounced', 'complained']),
          eq(mailMessages.claimedAt, input.claimedAt),
        ),
      )
      .returning({ id: mailMessages.id });
    if (updated.length === 0) return 'stale' as const;
    await recordMailEvent(tx, {
      messageId: input.id,
      kind: 'sent',
      provider: input.provider,
      occurredAt: input.now,
      type: input.type,
      category: input.category,
    });
    return 'sent' as const;
  });
}

/** A temporary failure waits for its retry; a permanent one, or the sixth, fails the mail. */
export async function recordMailFailure(
  db: Database,
  input: {
    id: string;
    type: string;
    category: MailCategory;
    provider: MailProviderName | null;
    code: string;
    permanent: boolean;
    attempts: number;
    claimedAt: Date;
    now: Date;
  },
): Promise<'retry' | 'failed' | 'stale'> {
  const attempts = input.attempts + 1;
  const failed = input.permanent || attempts >= MAX_ATTEMPTS;
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(mailMessages)
      .set({
        status: failed ? 'failed' : 'queued',
        ...(input.provider ? { provider: input.provider } : {}),
        attempts,
        lastError: input.code.slice(0, 80),
        claimedAt: null,
        ...(failed
          ? { finalAt: input.now }
          : {
              nextAttemptAt: new Date(
                input.now.getTime() + MAIL_BACKOFF_MS[attempts - 1]!,
              ),
            }),
      })
      .where(ownsClaim(input.id, input.claimedAt))
      .returning({ id: mailMessages.id });
    if (updated.length === 0) return 'stale' as const;
    // Every attempt is in the timeline; the day's "failed" count only counts final failures.
    await recordMailEvent(tx, {
      messageId: input.id,
      kind: 'send_failed',
      provider: input.provider,
      occurredAt: input.now,
      ...(failed ? { type: input.type, category: input.category } : {}),
    });
    return failed ? ('failed' as const) : ('retry' as const);
  });
}

/**
 * The provider's allowance is used up: the mail goes back to the queue for MAIL_QUOTA_RETRY_MS with
 * its attempts unchanged, so running out of credits never fails it. The timeline records the try;
 * the day's counts don't (no type), as for any retry.
 */
export async function recordMailDeferred(
  db: Database,
  input: {
    id: string;
    provider: MailProviderName | null;
    code: string;
    claimedAt: Date;
    now: Date;
  },
): Promise<'deferred' | 'stale'> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(mailMessages)
      .set({
        status: 'queued',
        ...(input.provider ? { provider: input.provider } : {}),
        lastError: input.code.slice(0, 80),
        claimedAt: null,
        nextAttemptAt: new Date(input.now.getTime() + MAIL_QUOTA_RETRY_MS),
      })
      .where(ownsClaim(input.id, input.claimedAt))
      .returning({ id: mailMessages.id });
    if (updated.length === 0) return 'stale' as const;
    await recordMailEvent(tx, {
      messageId: input.id,
      kind: 'send_failed',
      provider: input.provider,
      occurredAt: input.now,
    });
    return 'deferred' as const;
  });
}

/** Mail left `sending` by a worker that died goes back to the queue after two minutes. */
export async function requeueStuckMail(
  db: Database,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(mailMessages)
    .set({ status: 'queued', claimedAt: null })
    .where(
      and(
        eq(mailMessages.status, 'sending'),
        lt(mailMessages.claimedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    )
    .returning({ id: mailMessages.id });
  return rows.length;
}

/** Addresses and template data go 7 days after the final status; metadata and snapshots stay. */
export async function wipeExpiredMailContent(
  db: Database,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(mailMessages)
    .set({ toSealed: null, dataSealed: null })
    .where(
      and(
        lt(mailMessages.finalAt, new Date(now.getTime() - CONTENT_KEPT_MS)),
        isNotNull(mailMessages.toSealed),
      ),
    )
    .returning({ id: mailMessages.id });
  return rows.length;
}

export interface MailDeliveryDeps {
  db: Database;
  sealing: MailSealing;
  providers: ReadonlyMap<MailProviderName, MailProvider>;
  /**
   * The only provider announcements (bulk types) go through (announcementMailProvider). Null or
   * left out: none is set up, and announcements fail rather than fall back to `providers`.
   */
  announcementProvider?: MailProvider | null;
  activeProvider(): Promise<MailProviderName>;
  overrideFor(userId: string): Promise<MailProviderName | null>;
  /** The mail domain and brand name; each type's sender is an address on it. */
  sender: { domain: string; name: string; address?: string | undefined };
  replyTo?: string;
  webOrigin: string;
  /** A copy's own never-deliverable domains: their mail goes to the pretend inbox, if it has one. */
  pretendDomains?: readonly string[];
  /** Where one-click unsubscribe is answered (the API). */
  apiOrigin: string;
  /** Structured log of each outcome: ids, type, provider and codes only. */
  log?(entry: Record<string, string | number | null>): void;
  /** The same, for what staff must act on (the worker logs it as a warning). */
  warn?(entry: Record<string, string | number | null>): void;
  /** Automatic failover (owner, 23 Nov 2026). Left out, or with no fallbacks: today's behaviour. */
  failover?: MailFailoverDeps;
}

export interface MailFailoverDeps {
  /** The breaker, shared through Redis with the API and the other workers. */
  health: MailHealth;
  /** MAIL_FALLBACK_PROVIDERS, in order. Empty: nothing changes. */
  fallbacks: readonly MailProviderName[];
  /** MAIL_DEFAULT_PROVIDER: the backup when staff made a fallback active. */
  defaultProvider: MailProviderName;
  /** Production never falls back to the pretend provider. */
  production: boolean;
  /** Staff fixed the active provider in ops: no automatic switching. */
  fixed(): Promise<boolean>;
  /** MAIL_RESEND_WINDOW_MS: a code asked for again this soon goes through the next provider. */
  resendWindowMs: number;
}

export interface MailDeliveryResult {
  sent: number;
  retried: number;
  failed: number;
  expired: number;
  suppressed: number;
  skipped: number;
}

/**
 * One delivery pass: claim due mail, check it, render it and send it, one at a time, outside
 * any transaction. Each outcome is recorded before the next mail.
 */
export async function deliverDueMail(
  deps: MailDeliveryDeps,
  input: { now: Date; limit: number },
): Promise<MailDeliveryResult> {
  const result: MailDeliveryResult = {
    sent: 0,
    retried: 0,
    failed: 0,
    expired: 0,
    suppressed: 0,
    skipped: 0,
  };
  // Logging never changes what happens to a mail.
  const log = (entry: Record<string, string | number | null>) => {
    try {
      deps.log?.(entry);
    } catch {
      /* ignored */
    }
  };
  const warn = (entry: Record<string, string | number | null>) => {
    try {
      (deps.warn ?? deps.log)?.(entry);
    } catch {
      /* ignored */
    }
  };
  const claimed = await claimDueMail(deps.db, deps.sealing, input);
  if (claimed.length === 0) return result;
  const active = await deps.activeProvider();
  const configured = new Set(deps.providers.keys());
  // With no fallback, or the provider fixed in ops, nothing switches and the breaker is not asked.
  const failover =
    deps.failover &&
    deps.failover.fallbacks.length > 0 &&
    !(await deps.failover.fixed())
      ? deps.failover
      : null;
  // Set once the announcement provider says its allowance is used up: the rest of this pass's
  // announcements wait with it rather than each asking again.
  let quotaCode: string | null = null;
  for (const mail of claimed) {
    const gate = await mailGate(deps.db, deps.sealing, mail, input.now);
    if (gate !== 'send') {
      await finishWithoutSending(deps.db, mail, gate, input.now);
      if (gate === 'expired') result.expired += 1;
      else if (gate === 'suppressed') result.suppressed += 1;
      else result.skipped += 1;
      log({
        event: `mail.${gate}`,
        message_id: mail.id,
        type: mail.type,
      });
      continue;
    }
    // Announcements never fall back to the provider that sends sign-in codes (owner, 14 Nov 2026).
    const bulk = MAIL_TYPES[mail.type]?.bulk === true;
    const pretend =
      configured.has('mock') &&
      isPretendRecipient(mail.to, deps.pretendDomains ?? []);
    const override =
      !bulk && mail.userId ? await deps.overrideFor(mail.userId) : null;
    const routing = {
      pinned: mail.pinnedProvider,
      override,
      active,
      configured,
      to: mail.to,
      pretendDomains: deps.pretendDomains ?? [],
    };
    const routed: MailProviderName | null = bulk
      ? pretend
        ? 'mock'
        : (deps.announcementProvider?.name ?? null)
      : resolveMailProvider(routing);
    if (routed === null) {
      const outcome = await recordMailFailure(deps.db, {
        id: mail.id,
        type: mail.type,
        category: mail.category,
        provider: null,
        code: 'announcement_provider_missing',
        permanent: true,
        attempts: mail.attempts,
        claimedAt: mail.claimedAt,
        now: input.now,
      });
      if (outcome === 'failed') result.failed += 1;
      log({
        event: 'mail.failed',
        message_id: mail.id,
        type: mail.type,
        code: 'announcement_provider_missing',
      });
      continue;
    }
    const viaAnnouncementProvider = bulk && !pretend;
    const providerFor = (name: MailProviderName) =>
      viaAnnouncementProvider
        ? (deps.announcementProvider ?? undefined)
        : deps.providers.get(name);
    const fail = async (
      name: MailProviderName,
      code: string,
      permanent: boolean,
    ) => {
      const outcome = await recordMailFailure(deps.db, {
        id: mail.id,
        type: mail.type,
        category: mail.category,
        provider: name,
        code,
        permanent,
        attempts: mail.attempts,
        claimedAt: mail.claimedAt,
        now: input.now,
      });
      if (outcome === 'stale') return;
      if (outcome === 'failed') result.failed += 1;
      else result.retried += 1;
      log({
        event: outcome === 'failed' ? 'mail.failed' : 'mail.retry',
        message_id: mail.id,
        type: mail.type,
        provider: name,
        code,
      });
    };
    const defer = async (name: MailProviderName, code: string) => {
      const outcome = await recordMailDeferred(deps.db, {
        id: mail.id,
        provider: name,
        code,
        claimedAt: mail.claimedAt,
        now: input.now,
      });
      if (outcome === 'stale') return;
      result.retried += 1;
      log({
        event: 'mail.quota_wait',
        message_id: mail.id,
        type: mail.type,
        provider: name,
        code,
      });
    };
    if (!providerFor(routed)) {
      await fail(routed, 'provider_not_configured', false);
      continue;
    }
    if (viaAnnouncementProvider && quotaCode !== null) {
      await defer(routed, quotaCode);
      continue;
    }
    // Security, account and money mail always go, so they carry no way to turn them off.
    const unsubscribeUrl =
      mail.userId && canUnsubscribe(mail.type)
        ? `${deps.apiOrigin}/v1/mail/unsubscribe?t=${unsubscribeToken(deps.sealing, { userId: mail.userId, type: mail.type })}`
        : null;
    let rendered: ReturnType<typeof renderMail>;
    try {
      rendered = renderMail(mail.type, mail.data, {
        webOrigin: deps.webOrigin,
        unsubscribeUrl,
      });
    } catch {
      await fail(routed, 'render_failed', true);
      continue;
    }
    const outgoing: OutgoingMail = {
      reference: mail.id,
      to: mail.to,
      from: senderAddress(
        MAIL_TYPES[mail.type]?.sender ?? 'hello',
        deps.sender,
      ),
      ...(deps.replyTo ? { replyTo: deps.replyTo } : {}),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: unsubscribeUrl
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : {},
      tracking: MAIL_TYPES[mail.type]?.tracking ?? false,
    };
    // Automatic failover (owner, 23 Nov 2026), for mail other than announcements and only with a
    // fallback configured: the providers this mail may try, in order, skipping any the breaker is
    // resting. A provider whose rest is over takes trial traffic: one probe, or the next codes.
    // Without failover the chain is the one provider routing picks, exactly as before.
    const isCode = ONE_TIME_CODE_MAIL_TYPES.has(mail.type);
    const chain =
      failover && !bulk
        ? mailProviderChain({
            ...routing,
            defaultProvider: failover.defaultProvider,
            fallbacks: failover.fallbacks,
            production: failover.production,
            after: isCode
              ? await previousCodeProvider(
                  deps.db,
                  mail,
                  failover.resendWindowMs,
                )
              : null,
          })
        : [routed];
    const health = failover && !bulk ? failover.health : null;
    const views =
      health && chain.length > 1 ? await health.snapshot(chain) : null;
    const failures: Array<{ name: MailProviderName; error: unknown }> = [];
    let sent: { name: MailProviderName; providerMessageId: string } | null =
      null;
    let tried = 0;
    for (const name of chain) {
      const state = views?.get(name)?.state ?? 'healthy';
      if (state === 'resting') continue;
      const onTrial = state === 'trial';
      if (onTrial && !(await health!.claim(name, { code: isCode }))) continue;
      const provider = providerFor(name);
      if (!provider) continue;
      tried += 1;
      const outcome = await sendThrough(provider, outgoing);
      if ('providerMessageId' in outcome) {
        sent = { name, providerMessageId: outcome.providerMessageId };
        if (onTrial) await health!.succeeded(name);
        break;
      }
      failures.push({ name, error: outcome.error });
      const failure = sendFailureOf(outcome.error);
      // A definite failure counts toward the breaker and moves the mail on; anything else stops.
      if (failure.kind !== 'definite') break;
      if (health && name !== 'mock') await health.failed(name, failure.code);
    }
    // Every provider is resting: the one routing picks takes it, as without failover.
    if (tried === 0) {
      const outcome = await sendThrough(providerFor(routed)!, outgoing);
      if ('providerMessageId' in outcome)
        sent = { name: routed, providerMessageId: outcome.providerMessageId };
      else failures.push({ name: routed, error: outcome.error });
    }
    // The attempts before the last one are in the timeline (no type: not in the day's counts).
    const earlier = sent ? failures : failures.slice(0, -1);
    for (const { name, error } of earlier) {
      await recordMailEvent(deps.db, {
        messageId: mail.id,
        kind: 'send_failed',
        provider: name,
        occurredAt: input.now,
      });
      log({
        event: 'mail.failover',
        message_id: mail.id,
        type: mail.type,
        provider: name,
        code: sendFailureOf(error).code,
      });
    }
    if (!sent) {
      const { name: providerName, error } = failures.at(-1)!;
      // A quota error is a temporary error too, so it is checked first.
      if (error instanceof MailQuotaError) {
        if (viaAnnouncementProvider) quotaCode = error.code;
        // Security mail (codes, recovery and verification links) out of credits fails at once,
        // visibly, rather than waiting an hour it doesn't have: staff see it failed on the Email
        // console and the provider's card, and can switch provider by hand (review, 23 Nov 2026).
        if (!viaAnnouncementProvider && mail.category === 'security') {
          await fail(providerName, error.code, true);
          warn({
            event: 'mail.provider_out_of_credits',
            message_id: mail.id,
            type: mail.type,
            provider: providerName,
            code: error.code,
          });
        } else await defer(providerName, error.code);
      } else if (error instanceof MailRejectedError)
        await fail(providerName, error.code, true);
      else if (error instanceof MailTemporaryError)
        await fail(providerName, error.code, false);
      else await fail(providerName, 'send_error', false);
      continue;
    }
    const recorded = await recordMailSent(deps.db, {
      id: mail.id,
      type: mail.type,
      category: mail.category,
      provider: sent.name,
      providerMessageId: sent.providerMessageId,
      snapshot: rendered.snapshot,
      sealing: deps.sealing,
      claimedAt: mail.claimedAt,
      now: input.now,
    });
    if (recorded === 'sent') result.sent += 1;
    log({
      event: recorded === 'sent' ? 'mail.sent' : 'mail.sent_stale_claim',
      message_id: mail.id,
      type: mail.type,
      provider: sent.name,
    });
  }
  return result;
}

/**
 * Only the provider call: a failure after the provider accepted the mail must never be mistaken
 * for a send failure (that would send it again).
 */
async function sendThrough(
  provider: MailProvider,
  mail: OutgoingMail,
): Promise<{ providerMessageId: string } | { error: unknown }> {
  try {
    return await provider.send(mail);
  } catch (error) {
    return { error };
  }
}

/**
 * Where the pretend provider "delivers": the development-only pretend inbox, shown on /dev/inbox
 * and read by end-to-end tests. Only the masked hint is written, never the address.
 */
export function pretendMailSink(
  db: Database,
): (mail: OutgoingMail) => Promise<void> {
  return async (mail) => {
    const [row] = await db
      .select({ userId: mailMessages.userId, toHint: mailMessages.toHint })
      .from(mailMessages)
      .where(eq(mailMessages.id, mail.reference));
    await writePretendMessage(db, {
      channel: 'email',
      recipientHint: row?.toHint ?? 'unknown',
      userId: row?.userId ?? null,
      subject: mail.subject,
      body: mail.text,
    });
  };
}
