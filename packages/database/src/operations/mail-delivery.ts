import {
  MAIL_TYPES,
  MailRejectedError,
  MailTemporaryError,
  renderMail,
  resolveMailProvider,
  type MailCategory,
  type MailProvider,
  type MailProviderName,
  type OutgoingMail,
} from '@tipme/mail';
import { and, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  mailMessages,
  mailPreferences,
  mailSuppressions,
  profiles,
} from '../schema.js';
import {
  addressHmac,
  recordMailEvent,
  type MailSealing,
} from './mail-queue.js';
import { writePretendMessage } from './pretend-outbox.js';
import { openSecret, sealSecret } from './secret-box.js';

/** Waits before each retry; the sixth temporary failure fails the mail. */
export const MAIL_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000,
] as const;
const MAX_ATTEMPTS = MAIL_BACKOFF_MS.length + 1;
const STUCK_AFTER_MS = 2 * 60_000;
const CONTENT_KEPT_MS = 7 * 86_400_000;

export interface ClaimedMail {
  id: string;
  type: string;
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
 * Claims due mail (security first, then oldest), marking it `sending` so concurrent workers
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
  if (suppressed) return 'suppressed';
  if (!mail.userId) return 'send';
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
  if (mail.category === 'engagement' || mail.category === 'marketing') {
    const [prefs] = await db
      .select()
      .from(mailPreferences)
      .where(eq(mailPreferences.userId, mail.userId));
    if (mail.category === 'engagement' && prefs && !prefs.engagement)
      return 'skipped_preference';
    if (mail.category === 'marketing' && !prefs?.marketing)
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
        status: 'sent',
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        renderedSealed: input.snapshot
          ? sealSecret(input.sealing.key, JSON.stringify(input.snapshot))
          : null,
        attempts: sql`${mailMessages.attempts} + 1`,
        sentAt: input.now,
        finalAt: input.now,
        claimedAt: null,
        lastError: null,
      })
      .where(ownsClaim(input.id, input.claimedAt))
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
  activeProvider(): Promise<MailProviderName>;
  overrideFor(userId: string): Promise<MailProviderName | null>;
  from: { address: string; name: string };
  replyTo?: string;
  webOrigin: string;
  /** Structured log of each outcome: ids, type, provider and codes only. */
  log?(entry: Record<string, string | number | null>): void;
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
  const claimed = await claimDueMail(deps.db, deps.sealing, input);
  if (claimed.length === 0) return result;
  const active = await deps.activeProvider();
  const configured = new Set(deps.providers.keys());
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
    const providerName = resolveMailProvider({
      pinned: mail.pinnedProvider,
      override: mail.userId ? await deps.overrideFor(mail.userId) : null,
      active,
      configured,
    });
    const provider = deps.providers.get(providerName);
    const fail = async (code: string, permanent: boolean) => {
      const outcome = await recordMailFailure(deps.db, {
        id: mail.id,
        type: mail.type,
        category: mail.category,
        provider: providerName,
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
        provider: providerName,
        code,
      });
    };
    if (!provider) {
      await fail('provider_not_configured', false);
      continue;
    }
    let rendered: ReturnType<typeof renderMail>;
    try {
      rendered = renderMail(mail.type, mail.data, {
        webOrigin: deps.webOrigin,
        unsubscribeUrl: null,
      });
    } catch {
      await fail('render_failed', true);
      continue;
    }
    // Only the provider call is inside this try: a failure after the provider accepted the mail
    // must never be mistaken for a send failure (that would send it again).
    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.send({
        reference: mail.id,
        to: mail.to,
        from: deps.from,
        ...(deps.replyTo ? { replyTo: deps.replyTo } : {}),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {},
        tracking: MAIL_TYPES[mail.type]?.tracking ?? false,
      }));
    } catch (error) {
      if (error instanceof MailRejectedError) await fail(error.code, true);
      else if (error instanceof MailTemporaryError)
        await fail(error.code, false);
      else await fail('send_error', false);
      continue;
    }
    const recorded = await recordMailSent(deps.db, {
      id: mail.id,
      type: mail.type,
      category: mail.category,
      provider: providerName,
      providerMessageId,
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
      provider: providerName,
    });
  }
  return result;
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
