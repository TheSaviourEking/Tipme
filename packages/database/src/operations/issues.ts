import type {
  OpsFreezeReleased,
  OpsIssue,
  OpsIssueOutcome,
} from '@tipme/contracts';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issueNotes,
  issues,
  paymentAccounts,
  paymentAttempts,
  paymentIntents,
  payouts,
  phoneRecoveries,
  profiles,
  tips,
  withdrawalHolds,
  type IssueKind,
  type IssueSeverity,
  type IssueSubject,
} from '../schema.js';
import { enqueueOutbox } from './outbox.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { canonicalId, readMailboxes, sharesMailbox } from './staff.js';

const STUCK_AFTER_MS = 30 * 60 * 1000;
const ACTED_ALONE_CLOSES_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The issues that place a hold, and so the only ones that keep it. A failed withdrawal or an unknown
 * start says nothing about why a hold was placed, and some of them never close.
 */
const HOLD_KINDS = [
  'payment_reversed',
  'provider_in_debt',
  'payout_unexpected',
  'account_takeover_reported',
] as const satisfies readonly IssueKind[];
const HOLD_KINDS_SQL = sql.join(
  HOLD_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
);

/** Outbox alerts that need a person, and the issue kind each becomes. */
const EVENT_KINDS: Record<string, IssueKind> = {
  'payment.mismatch': 'payment_mismatch',
  'payment.conflict': 'payment_conflict',
  'payment.unresolved': 'payment_unresolved',
  'payment.reversed': 'payment_reversed',
  'payout.failed': 'payout_failed',
  'payout.conflict': 'payout_conflict',
  'provider_event.conflict': 'provider_event_conflict',
  'ops.acted_alone': 'staff_acted_alone',
  'ops.approval_pending': 'staff_approval_pending',
  'ops.last_approver_removed': 'staff_last_approver_removed',
  // Paid Pro (ADR-0015).
  'pro.amount_mismatch': 'pro_amount_mismatch',
  'pro.late_payment': 'pro_late_payment',
  'pro.conflict': 'pro_conflict',
  'pro.reversed': 'pro_reversed',
  'pro.collect_unknown': 'pro_collect_unknown',
  'pro.refund_failed': 'pro_refund_failed',
};
export const ISSUE_EVENT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(EVENT_KINDS),
);
/** Alerts about what a staff member did, or asked for: the issue records who. */
const OWN_ALERT_EVENTS: ReadonlySet<string> = new Set([
  'ops.acted_alone',
  'ops.approval_pending',
  'ops.last_approver_removed',
]);

const SEVERITY: Record<IssueKind, IssueSeverity> = {
  payment_mismatch: 'money',
  payment_conflict: 'money',
  payment_unresolved: 'money',
  payment_attempt_unresolved: 'money',
  payment_account_unresolved: 'account',
  payment_account_setup_failed: 'account',
  payment_reversed: 'money',
  payment_settlement_currency: 'money',
  payout_failed: 'money',
  payout_conflict: 'money',
  payout_unexpected: 'money',
  payout_unresolved: 'money',
  payout_fee_short: 'money',
  payout_fee_adjusted: 'info',
  payout_held: 'money',
  account_takeover_reported: 'money',
  provider_in_debt: 'money',
  reserve_empty: 'money',
  provider_key_refused: 'money',
  provider_event_conflict: 'money',
  stuck_tip: 'info',
  unmatched_event: 'info',
  pending_recovery: 'account',
  message_reported: 'account',
  profile_reported: 'account',
  staff_acted_alone: 'account',
  staff_approval_pending: 'info',
  staff_last_approver_removed: 'account',
  username_take_back_unnoticed: 'account',
  username_take_back_overdue: 'account',
  business_waiting: 'info',
  business_note_reported: 'account',
  share_report: 'account',
  balance_below_zero: 'money',
  pro_amount_mismatch: 'money',
  pro_late_payment: 'info',
  pro_conflict: 'money',
  pro_reversed: 'money',
  support_request: 'account',
  pro_collect_unknown: 'money',
  pro_refund_failed: 'money',
};

/** Plain words for the inbox. Ids and the public handle only: never names, messages or numbers. */
function summaryOf(kind: IssueKind, handle: string | null): string {
  const page = handle ? `@${handle}` : 'a recipient';
  switch (kind) {
    case 'payment_mismatch':
      return `The provider reported a different amount or currency for a tip to ${page}. Nothing was booked.`;
    case 'payment_conflict':
      return `The provider says a payment succeeded for a tip to ${page} that had already ended. Money may have been taken.`;
    case 'payment_unresolved':
      return `The provider has no record of a payment for a tip to ${page} after 30 minutes.`;
    case 'payment_attempt_unresolved':
      return `A Bachs checkout for a tip to ${page} has an unknown outcome. Find and verify the checkout in Bachs Dashboard; do not retry it.`;
    case 'payment_account_unresolved':
      return `Bachs account setup for ${page} has an unknown outcome. Confirm the recipient account in Bachs Dashboard before linking it.`;
    case 'payment_account_setup_failed':
      return `Manual payouts could not be set on the payment account for ${page}. They can't withdraw, and can't finish setup if it isn't done. TipMe keeps trying, and this closes itself once it works. If it stays open, check the account at the provider.`;
    case 'payment_reversed':
      return `Bachs reported a refund or dispute on a paid tip to ${page}. TipMe changed no balance: review it in Bachs Dashboard.`;
    case 'payment_settlement_currency':
      return `Bachs took a tip to ${page} but settled it in another currency, so it cannot confirm the fee. Turn on NGN under Currencies held for their Bachs account, then confirm the fee below.`;
    case 'payout_failed':
      return `A withdrawal for ${page} failed. The money is back in their balance.`;
    case 'payout_conflict':
      return `The provider’s record of a withdrawal for ${page} conflicts with TipMe’s.`;
    case 'payout_unexpected':
      return `The provider paid out money for ${page} that TipMe did not ask for. Withdrawals for them are on hold until it is checked.`;
    case 'payout_unresolved':
      return `A withdrawal for ${page} has an unknown outcome. Find it at the provider and verify it; do not start it again.`;
    case 'payout_fee_adjusted':
      return `The provider charged a different fee for a withdrawal for ${page} than the one taken from the amount. The difference was settled on their balance (more taken, or less credited back); TipMe paid nothing. For information.`;
    case 'payout_fee_short':
      return `The provider charged more for a withdrawal for ${page} than the fee TipMe charged them or covered, so their balance there is short by the difference. TipMe absorbs it: top it up.`;
    case 'payout_held':
      return `A withdrawal for ${page} was not started because their withdrawals went on hold first. Nothing was sent, and the money stays reserved.`;
    case 'provider_in_debt':
      return `The provider reports ${page}’s account owes it money. Withdrawals for them are on hold until it is settled.`;
    case 'reserve_empty':
      return 'The platform reserve could not cover a payout fee, so withdrawals are waiting. Nothing failed and the recipients were not told. Top up the reserve: they start again once a reading is at the alert level, and this closes itself.';
    case 'provider_key_refused':
      return 'The provider refused TipMe’s API key. Withdrawals are waiting and adding a bank account is unavailable; recipients are told to try later. Check the key and its permissions, then resolve this. Waiting withdrawals start again at the next reserve reading at the alert level.';
    case 'provider_event_conflict':
      return `The provider sent the same event twice with different contents (tip to ${page}).`;
    case 'stuck_tip':
      return `A tip to ${page} has been confirming for more than 30 minutes.`;
    case 'unmatched_event':
      return 'The provider sent an event TipMe could not match to any payment or withdrawal.';
    case 'message_reported':
      return `${page} reported a supporter’s message. Reveal it (with a reason) to review it.`;
    case 'profile_reported':
      return `Visitors reported ${page} (impersonation, a scam or abuse). Check the page, and pause it if needed.`;
    case 'account_takeover_reported':
      return `Someone reported that ${page}’s account was taken over. Staff froze its withdrawals; the audit log has why. Once the real owner has it back, resolve this to release them.`;
    case 'staff_acted_alone':
      return 'A staff member took a serious action without a second person, because none was available.';
    case 'staff_approval_pending':
      return 'A serious action is waiting for a second person. Decide it under Approvals.';
    case 'staff_last_approver_removed':
      return 'A staff change left nobody else to act as second person, so one person can now take serious actions alone.';
    case 'username_take_back_unnoticed':
      return `A username take-back for ${page} was approved 24 hours ago, but the notice hasn't reached them by email or on their dashboard. It goes ahead after 14 days if it never does. Cancel it under Usernames if needed.`;
    case 'username_take_back_overdue':
      return `A username take-back for ${page} is more than an hour past its deadline and hasn't completed. The worker retries every minute.`;
    case 'business_waiting':
      return 'A business is waiting to be verified. Check its name, address and contact before its codes go live.';
    case 'business_note_reported':
      return 'A note a supporter wrote about someone at a business was reported. Read it only through Reveal.';
    case 'share_report':
      return 'Someone who works at a business reported it over a share of their tips. The business is never told.';
    case 'balance_below_zero':
      return `A reversed tip left a balance below zero (${page} or a business). Withdrawals for it stop until it is back above zero. Nothing is collected automatically.`;
    case 'pending_recovery':
      return `Someone asked to move ${handle ? `@${handle}’s` : 'an'} account to a new number by email recovery. It waits 24 hours.`;
    case 'pro_amount_mismatch':
      return `A Pro payment for ${page} came back from the partner with a different amount or currency than its purchase. Nothing was booked and no Pro month started. Check it in the partner dashboard.`;
    case 'pro_late_payment':
      return `A Pro payment for ${page} was confirmed after its checkout had ended (a late bank transfer). It was credited: their Pro month starts from the confirmation.`;
    case 'pro_conflict':
      return `The partner reported a Pro payment for ${page} as failed after TipMe had confirmed it paid, or a paid one that couldn't start a month. Check it in the partner dashboard.`;
    case 'pro_collect_unknown':
      return `A Pro payment from ${page}'s TipMe balance got no clear answer from the partner and none was found when read back. Its amount stays reserved; nothing was booked. Check the partner dashboard for a transfer from their account before releasing it.`;
    case 'pro_refund_failed':
      return `The partner could not refund a Pro card payment for ${page}. Their Pro month is unchanged and nothing was booked. A failed refund doesn't count, so it can be asked again.`;
    case 'pro_reversed':
      return `The partner reported a refund or dispute on a Pro payment for ${page}. A paid refund or a lost dispute ends that Pro month; nothing else was changed.`;
    case 'support_request':
      return `A support request from ${page}. Reveal it to read their words and how to reach them.`;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : undefined;

/** Fills in the related ids (attempt → tip → page; payout → page) and finds the handle. */
async function completeSubject(
  tx: Database | Tx,
  subject: IssueSubject,
): Promise<{
  subject: IssueSubject;
  handle: string | null;
  rehearsal: boolean;
}> {
  const filled: IssueSubject = { ...subject };
  if (filled.attemptId && !filled.tipId) {
    const [row] = await tx
      .select({ tipId: tips.id })
      .from(paymentAttempts)
      .innerJoin(tips, eq(tips.intentId, paymentAttempts.intentId))
      .where(eq(paymentAttempts.id, filled.attemptId));
    if (row) filled.tipId = row.tipId;
  }
  if (filled.tipId && !filled.profileId) {
    const [row] = await tx
      .select({ profileId: tips.profileId })
      .from(tips)
      .where(eq(tips.id, filled.tipId));
    if (row) filled.profileId = row.profileId ?? undefined;
  }
  if (filled.payoutId && !filled.profileId) {
    const [row] = await tx
      .select({ profileId: payouts.profileId })
      .from(payouts)
      .where(eq(payouts.id, filled.payoutId));
    if (row) filled.profileId = row.profileId ?? undefined;
  }
  if (filled.userId && !filled.profileId) {
    const [row] = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.userId, filled.userId));
    if (row) filled.profileId = row.id;
  }
  let handle: string | null = null;
  let rehearsal = false;
  if (filled.profileId) {
    const [row] = await tx
      .select({
        handle: profiles.handle,
        userId: profiles.userId,
        rehearsalRunId: profiles.rehearsalRunId,
      })
      .from(profiles)
      .where(eq(profiles.id, filled.profileId));
    handle = row?.handle ?? null;
    rehearsal = Boolean(row?.rehearsalRunId);
    if (row?.userId && !filled.userId) filled.userId = row.userId;
  }
  return { subject: filled, handle, rehearsal };
}

export async function openIssue(
  tx: Database | Tx,
  input: {
    dedupeKey: string;
    kind: IssueKind;
    subject: IssueSubject;
    now: Date;
    /** Ids and plain words only: what is known about this case, after the kind's summary. */
    note?: string;
    /** A Pro member's support request: sorted first among open issues. */
    priority?: boolean;
  },
): Promise<{ id: string; opened: boolean }> {
  const { subject, handle, rehearsal } = await completeSubject(
    tx,
    input.subject,
  );
  const inserted = await tx
    .insert(issues)
    .values({
      id: newId(),
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      severity: SEVERITY[input.kind],
      subject,
      summary: input.note
        ? `${summaryOf(input.kind, handle)} ${input.note}`
        : summaryOf(input.kind, handle),
      openedAt: input.now,
      rehearsal,
      priority: input.priority === true,
    })
    .onConflictDoNothing({ target: issues.dedupeKey })
    .returning({ id: issues.id });
  if (inserted[0]) return { id: inserted[0].id, opened: true };
  // Already there (open or not): a hold in the same transaction still needs to point at it.
  const [existing] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.dedupeKey, input.dedupeKey));
  if (!existing) throw new OperationError('ISSUE_NOT_FOUND');
  return { id: existing.id, opened: false };
}

/** Our own names and ids only, and checked, so the note can't carry anything else. */
function actedAloneNote(payload: Record<string, unknown>): string {
  const action =
    typeof payload.action === 'string' && /^[a-z_.]{1,60}$/.test(payload.action)
      ? payload.action
      : 'unknown';
  return `Action: ${action}. Staff member: ${idOf(payload.requestedBy) ?? 'unknown'}. The audit log has the reason. Someone else must close this; if nobody does, it closes itself after 30 days.`;
}

const PERMISSION_LIST = /^[a-z_.,]{1,400}$/;

/** Same care as above. A pending request closes its issue once decided; the other asks for a person. */
function staffAlertNote(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  const actor = idOf(payload.requestedBy) ?? 'unknown';
  if (eventType === 'ops.approval_pending') {
    const action =
      typeof payload.action === 'string' &&
      /^[a-z_.]{1,60}$/.test(payload.action)
        ? payload.action
        : 'unknown';
    return `Action: ${action}. Requested by: ${actor}. This closes itself once the request is decided or expires.`;
  }
  const permissions =
    typeof payload.permissions === 'string' &&
    PERMISSION_LIST.test(payload.permissions)
      ? payload.permissions
      : 'unknown';
  return `Permissions: ${permissions}. Changed by: ${actor}. The audit log has the reason. Someone else must close this; if nobody does, it closes itself after 30 days.`;
}

/** One issue per outbox alert, keyed by the alert's dedupe key, so redelivery changes nothing. */
export function openIssueFromEvent(
  db: Database,
  input: { eventType: string; dedupeKey: string; payload: unknown; now?: Date },
): Promise<'opened' | 'duplicate' | 'ignored'> {
  const kind = EVENT_KINDS[input.eventType];
  if (!kind) return Promise.resolve('ignored');
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const subject: IssueSubject = {};
  for (const key of [
    'tipId',
    'attemptId',
    'payoutId',
    'profileId',
    'providerEventRowId',
  ] as const) {
    const id = idOf(payload[key]);
    if (id) subject[key] = id;
  }
  // Who acted, so they can't be the one to close it.
  if (OWN_ALERT_EVENTS.has(input.eventType)) {
    const actor = idOf(payload.requestedBy);
    if (actor) subject.userId = actor;
  }
  const requestId = idOf(payload.requestId);
  if (input.eventType === 'ops.approval_pending' && requestId)
    subject.requestId = requestId;
  return guarded(async () =>
    (
      await openIssue(db, {
        dedupeKey: `event.${input.dedupeKey}`,
        kind,
        subject,
        now: input.now ?? new Date(),
        ...(input.eventType === 'payout.conflict'
          ? {
              note: 'It says the withdrawal was paid after TipMe recorded it as failed.',
            }
          : {}),
        ...(input.eventType === 'ops.acted_alone'
          ? { note: actedAloneNote(payload) }
          : {}),
        ...(input.eventType === 'ops.approval_pending' ||
        input.eventType === 'ops.last_approver_removed'
          ? { note: staffAlertNote(input.eventType, payload) }
          : {}),
      })
    ).opened
      ? 'opened'
      : 'duplicate',
  );
}

/**
 * Scheduled checks (run with reconciliation): tips confirming for more than 30 minutes, provider
 * events nobody could match, and pending phone recoveries. Each cause opens one issue.
 */
export function runIssueDetectors(
  db: Database,
  now: Date,
): Promise<{ opened: number }> {
  return guarded(async () => {
    let opened = 0;
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
    const stuck = await db.execute<{ id: string }>(sql`
      SELECT t.id FROM tips t
       WHERE t.created_at < ${stuckBefore}
         AND (t.status = 'PENDING_VERIFICATION'
              OR (t.status = 'AWAITING_PAYMENT' AND EXISTS (
                    SELECT 1 FROM payment_attempts a
                     WHERE a.intent_id = t.intent_id AND a.status = 'PENDING')))
         AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'stuck_tip.' || t.id)
       LIMIT 500`);
    for (const row of stuck.rows)
      if (
        (
          await openIssue(db, {
            dedupeKey: `stuck_tip.${row.id}`,
            kind: 'stuck_tip',
            subject: { tipId: row.id },
            now,
          })
        ).opened
      )
        opened += 1;
    const unmatched = await db.execute<{ id: string }>(sql`
      SELECT u.id FROM unmatched_provider_events u
       WHERE NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'unmatched.' || u.id)
         -- Parked for reconciliation, which applies it or opens payout_unexpected.
         AND NOT (u.provider = 'bachs' AND u.reason = 'unknown_payout')
       LIMIT 500`);
    for (const row of unmatched.rows)
      if (
        (
          await openIssue(db, {
            dedupeKey: `unmatched.${row.id}`,
            kind: 'unmatched_event',
            subject: { unmatchedId: row.id },
            now,
          })
        ).opened
      )
        opened += 1;
    // Either Bachs environment: a copy holds only its own environment's accounts, and the
    // dedupe key is per account row.
    const unknownAccounts = await db
      .select({ id: paymentAccounts.id, profileId: paymentAccounts.profileId })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.status, 'UNKNOWN'),
          isNull(paymentAccounts.providerAccountReference),
          sql`NOT EXISTS (
            SELECT 1 FROM issues i
             WHERE i.dedupe_key = 'payment_account_unresolved.' || ${paymentAccounts.id}
          )`,
        ),
      )
      .limit(500);
    for (const row of unknownAccounts)
      if (
        (
          await openIssue(db, {
            dedupeKey: `payment_account_unresolved.${row.id}`,
            kind: 'payment_account_unresolved',
            subject: { profileId: row.profileId ?? undefined },
            now,
          })
        ).opened
      )
        opened += 1;
    const unknownAttempts = await db
      .select({ id: paymentAttempts.id, tipId: tips.id })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tips, eq(tips.intentId, paymentIntents.id))
      .where(
        and(
          eq(paymentAttempts.provider, 'bachs'),
          eq(paymentAttempts.status, 'UNKNOWN'),
          isNull(paymentAttempts.providerReference),
          lt(paymentAttempts.createdAt, stuckBefore),
          sql`NOT EXISTS (
            SELECT 1 FROM issues i
             WHERE i.dedupe_key = 'payment_attempt_unresolved.' || ${paymentAttempts.id}
          )`,
        ),
      )
      .limit(500);
    for (const row of unknownAttempts)
      if (
        (
          await openIssue(db, {
            dedupeKey: `payment_attempt_unresolved.${row.id}`,
            kind: 'payment_attempt_unresolved',
            subject: { attemptId: row.id, tipId: row.tipId },
            now,
          })
        ).opened
      )
        opened += 1;
    const recoveries = await db
      .select({ id: phoneRecoveries.id, userId: phoneRecoveries.userId })
      .from(phoneRecoveries)
      .where(
        and(
          isNull(phoneRecoveries.cancelledAt),
          isNull(phoneRecoveries.completedAt),
          sql`NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'recovery.' || ${phoneRecoveries.id})`,
        ),
      )
      .limit(500);
    for (const row of recoveries)
      if (
        (
          await openIssue(db, {
            dedupeKey: `recovery.${row.id}`,
            kind: 'pending_recovery',
            subject: { recoveryId: row.id, userId: row.userId },
            now,
          })
        ).opened
      )
        opened += 1;
    // Username take-backs (username reservation spec, 5.8): a notice that reached nobody in a day,
    // and a deadline an hour past without completing.
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const takeBacks = await db.execute<{
      id: string;
      profile_id: string;
      handle_lower: string;
      kind: string;
      issue: 'username_take_back_unnoticed' | 'username_take_back_overdue';
    }>(sql`
      SELECT id, profile_id, handle_lower, kind, 'username_take_back_unnoticed' AS issue
        FROM handle_take_backs
       WHERE state = 'approved' AND noticed_at IS NULL
         AND approved_at <= ${dayAgo}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'username_take_back_unnoticed.' || handle_take_backs.id)
      UNION ALL
      SELECT id, profile_id, handle_lower, kind, 'username_take_back_overdue'
        FROM handle_take_backs
       WHERE state NOT IN ('done', 'cancelled')
         AND due_at <= ${hourAgo}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'username_take_back_overdue.' || handle_take_backs.id)
       LIMIT 500`);
    for (const row of takeBacks.rows)
      if (
        (
          await openIssue(db, {
            dedupeKey: `${row.issue}.${row.id}`,
            kind: row.issue,
            subject: { profileId: row.profile_id },
            now,
            // The summary names the page; an old username being taken back is named here.
            ...(row.kind === 'old'
              ? { note: `The old username is @${row.handle_lower}.` }
              : {}),
          })
        ).opened
      )
        opened += 1;
    return { opened };
  });
}

/** Marks one open issue resolved and audits it, in one transaction. */
export async function markResolved(
  tx: Tx,
  input: {
    issueId: string;
    resolvedBy: string;
    staffUserId: string | null;
    reason: string;
    /** For a money issue: how it was settled. Stored only; no balance changes. */
    outcome?: OpsIssueOutcome;
    now: Date;
  },
): Promise<boolean> {
  const updated = await tx
    .update(issues)
    .set({
      status: 'resolved',
      resolvedAt: input.now,
      resolvedBy: input.resolvedBy,
      resolutionOutcome: input.outcome ?? null,
    })
    .where(and(eq(issues.id, input.issueId), eq(issues.status, 'open')))
    .returning({
      id: issues.id,
      severity: issues.severity,
      subject: issues.subject,
    });
  const [closed] = updated;
  if (!closed) return false;
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: input.staffUserId ? 'issue.resolved' : 'issue.auto_resolved',
    permission: input.staffUserId
      ? closed.severity === 'money'
        ? 'payouts.resolve'
        : 'issues.resolve'
      : undefined,
    subjectType: 'issue',
    subjectId: input.issueId,
    reason: input.reason,
    now: input.now,
  });
  if (closed.severity === 'money' && closed.subject.profileId)
    await releaseHoldsIfClear(tx, {
      profileId: closed.subject.profileId,
      staffUserId: input.staffUserId,
      now: input.now,
    });
  return true;
}

/**
 * The recipient's withdrawals resume once none of the issues that place holds is open for them,
 * however the last one closed. A takeover freeze goes only by its own issue closing as "the owner has
 * the account back". The profile lock makes two closes take turns, so neither misses the other.
 */
async function releaseHoldsIfClear(
  tx: Tx,
  input: { profileId: string; staffUserId: string | null; now: Date },
): Promise<void> {
  await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, input.profileId))
    .for('update');
  const other = await tx
    .select({ kind: issues.kind })
    .from(issues)
    .where(
      and(
        eq(issues.status, 'open'),
        sql`${issues.kind} IN (${HOLD_KINDS_SQL})`,
        sql`${issues.subject}->>'profileId' = ${input.profileId}`,
      ),
    );
  if (other.length > 0) {
    const [held] = await tx
      .select({ id: withdrawalHolds.id })
      .from(withdrawalHolds)
      .where(
        and(
          eq(withdrawalHolds.profileId, input.profileId),
          isNull(withdrawalHolds.releasedAt),
        ),
      )
      .limit(1);
    if (held)
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'withdrawals.still_held',
        permission: input.staffUserId ? 'payouts.resolve' : undefined,
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: `Still open: ${[...new Set(other.map(({ kind }) => kind))].join(', ')}.`,
        now: input.now,
      });
    return;
  }
  const released = await tx
    .update(withdrawalHolds)
    // The database's clock, as for the times this is compared with: a hold's start, a request, and
    // a Resume. The app's may differ, and a Resume mustn't count for a hold that ended after it.
    .set({ releasedAt: sql`clock_timestamp()`, releasedBy: input.staffUserId })
    .where(
      and(
        eq(withdrawalHolds.profileId, input.profileId),
        isNull(withdrawalHolds.releasedAt),
        // Holds take no profile lock, so one may have been placed since the search above. A hold
        // goes only once its own cause has closed, so a new one can't be released as it is placed.
        sql`EXISTS (
          SELECT 1 FROM issues i
           WHERE i.id = ${withdrawalHolds.issueId} AND i.status <> 'open'
             AND (${withdrawalHolds.reason} <> 'account_takeover'
                  OR i.resolution_outcome = 'account_secured'))`,
      ),
    )
    .returning({ id: withdrawalHolds.id });
  if (released.length > 0)
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: 'withdrawals.released',
      permission: input.staffUserId ? 'payouts.resolve' : undefined,
      subjectType: 'profile',
      subjectId: input.profileId,
      reason:
        'None of the issues that hold the recipient’s withdrawals is open.',
      now: input.now,
    });
}

/** Resolves issues whose cause has cleared (resolver `system`, audited). */
export function autoResolveIssues(
  db: Database,
  now: Date,
): Promise<{ resolved: number }> {
  return guarded(async () => {
    const cleared = await db.execute<{ id: string; reason: string }>(sql`
      SELECT i.id, 'The tip reached a final state.' AS reason
        FROM issues i JOIN tips t ON t.id = (i.subject->>'tipId')::uuid
       WHERE i.status = 'open' AND i.kind = 'stuck_tip'
         AND t.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      UNION ALL
      SELECT i.id, 'The provider gave a final answer for the payment.'
        FROM issues i JOIN payment_attempts a ON a.id = (i.subject->>'attemptId')::uuid
       WHERE i.status = 'open' AND i.kind = 'payment_unresolved'
         AND a.status IN ('VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED')
      UNION ALL
      SELECT i.id, 'The provider gave a final answer for the payment.'
        FROM issues i
        JOIN payment_attempts a
          ON a.id = (i.subject->>'attemptId')::uuid
       WHERE i.status = 'open'
         AND i.kind IN ('payment_attempt_unresolved', 'payment_settlement_currency')
         AND a.status IN ('VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED')
      UNION ALL
      SELECT i.id, 'The Bachs recipient account was found and its status was synchronized.'
        FROM issues i
       WHERE i.status = 'open' AND i.kind = 'payment_account_unresolved'
         -- Either Bachs environment; cleared only once none of the profile's accounts is still the
         -- unknown creation the detector raised it for.
         AND EXISTS (
           SELECT 1 FROM payment_accounts a
            WHERE a.profile_id = (i.subject->>'profileId')::uuid
              AND a.provider = 'bachs'
              AND a.status <> 'UNKNOWN'
              AND a.provider_account_reference IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM payment_accounts a
            WHERE a.profile_id = (i.subject->>'profileId')::uuid
              AND a.provider = 'bachs'
              AND a.status = 'UNKNOWN'
              AND a.provider_account_reference IS NULL)
      UNION ALL
      SELECT i.id, 'Manual payouts are now set on the account.'
        FROM issues i
        JOIN payment_accounts a ON i.dedupe_key = 'payment_account_setup.' || a.id
       WHERE i.status = 'open' AND i.kind = 'payment_account_setup_failed'
         AND a.manual_payouts_at IS NOT NULL
      UNION ALL
      SELECT i.id, 'The withdrawal was found at the provider or reached a final state.'
        FROM issues i JOIN payouts p ON p.id = (i.subject->>'payoutId')::uuid
       WHERE i.status = 'open' AND i.kind IN ('payout_unresolved', 'payout_held')
         -- Finding the reference answers an unknown start, not a payout stuck after it.
         AND (p.status NOT IN ('REQUESTED', 'PROCESSING')
              OR (p.provider_reference IS NOT NULL
                  AND i.dedupe_key NOT LIKE 'payout_stuck.%'))
      UNION ALL
      -- A payout with its own open issue is a person's now, and no longer the reserve's to answer for.
      SELECT i.id, 'No withdrawal is waiting on the reserve any more.'
        FROM issues i
       WHERE i.status = 'open' AND i.kind = 'reserve_empty'
         AND NOT EXISTS (
           SELECT 1 FROM payouts p
            WHERE p.status = 'REQUESTED'
              AND p.platform_wait_since IS NOT NULL
              AND p.provider_reference IS NULL
              AND p.start_uncertain_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM issues pi
                 WHERE pi.status = 'open' AND pi.subject->>'payoutId' = p.id::text))
      UNION ALL
      -- Raised after its release check finished (the misreported tip never confirms).
      SELECT i.id, 'The release check that raised it has finished.'
        FROM issues i
        JOIN profiles p ON p.id = (i.subject->>'profileId')::uuid
        JOIN release_runs r ON r.id = p.rehearsal_run_id
       WHERE i.status = 'open' AND i.rehearsal AND r.finished_at IS NOT NULL
      UNION ALL
      -- A lone admin can't close their own alert, and with nobody else it mustn't stay open forever.
      SELECT i.id, 'Closed automatically after 30 days: nobody else was available to close it.'
        FROM issues i
       WHERE i.status = 'open' AND i.kind IN ('staff_acted_alone', 'staff_last_approver_removed')
         AND i.opened_at < ${new Date(now.getTime() - ACTED_ALONE_CLOSES_AFTER_MS).toISOString()}::timestamptz
      UNION ALL
      SELECT i.id, 'The request was decided, cancelled or expired.'
        FROM issues i JOIN approval_requests r ON r.id = (i.subject->>'requestId')::uuid
       WHERE i.status = 'open' AND i.kind = 'staff_approval_pending'
         AND r.status <> 'pending'
      UNION ALL
      SELECT i.id, 'The take-back notice reached them, or the take-back ended.'
        FROM issues i JOIN handle_take_backs tb ON i.dedupe_key = 'username_take_back_unnoticed.' || tb.id
       WHERE i.status = 'open' AND i.kind = 'username_take_back_unnoticed'
         AND tb.state <> 'approved'
      UNION ALL
      SELECT i.id, 'The take-back completed or was cancelled.'
        FROM issues i JOIN handle_take_backs tb ON i.dedupe_key = 'username_take_back_overdue.' || tb.id
       WHERE i.status = 'open' AND i.kind = 'username_take_back_overdue'
         AND tb.state IN ('done', 'cancelled')
      UNION ALL
      SELECT i.id, 'The recovery was completed or cancelled.'
        FROM issues i JOIN phone_recoveries r ON r.id = (i.subject->>'recoveryId')::uuid
       WHERE i.status = 'open' AND i.kind = 'pending_recovery'
         AND (r.completed_at IS NOT NULL OR r.cancelled_at IS NOT NULL)
      LIMIT 500`);
    let resolved = 0;
    for (const row of cleared.rows)
      if (
        await db.transaction((tx) =>
          markResolved(tx, {
            issueId: row.id,
            resolvedBy: 'system',
            staffUserId: null,
            reason: row.reason,
            now,
          }),
        )
      )
        resolved += 1;
    return { resolved };
  });
}

export type IssueView = OpsIssue;

const view = (row: typeof issues.$inferSelect): IssueView => ({
  id: row.id,
  kind: row.kind as IssueKind,
  severity: row.severity as IssueSeverity,
  status: row.status as 'open' | 'resolved',
  subject: row.subject,
  summary: row.summary,
  openedAt: row.openedAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  resolvedBy: row.resolvedBy,
  resolutionOutcome: (row.resolutionOutcome as OpsIssueOutcome | null) ?? null,
  priority: row.priority,
});

/** Newest first; `cursor` is the id of the last issue already shown. */
export function listIssues(
  db: Database,
  input: {
    status?: 'open' | 'resolved';
    kind?: IssueKind;
    severity?: IssueSeverity;
    cursor?: string;
    limit: number;
    /** Release-check issues are hidden unless asked for (PR-010). */
    includeRehearsal?: boolean;
  },
): Promise<IssueView[]> {
  const priorityFirst = input.status === 'open';
  return guarded(async () => {
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          input.includeRehearsal ? undefined : eq(issues.rehearsal, false),
          input.status ? eq(issues.status, input.status) : undefined,
          input.kind ? eq(issues.kind, input.kind) : undefined,
          input.severity ? eq(issues.severity, input.severity) : undefined,
          input.cursor && UUID.test(input.cursor)
            ? priorityFirst
              ? // Keyset over (priority, id), both descending.
                sql`(${issues.priority}, ${issues.id}) < (SELECT c.priority, c.id FROM issues c WHERE c.id = ${input.cursor})`
              : lt(issues.id, input.cursor)
            : undefined,
        ),
      )
      .orderBy(
        // The open queue puts Pro members' support requests first (priority support); the rest
        // stay newest first.
        ...(priorityFirst ? [desc(issues.priority)] : []),
        desc(issues.id),
      )
      .limit(Math.min(Math.max(input.limit, 1), 100));
    return rows.map(view);
  });
}

export function issueById(db: Database, id: string): Promise<IssueView | null> {
  if (!UUID.test(id)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row ? view(row) : null;
  });
}

/**
 * What keeps a recipient's withdrawals on hold, so staff can see why a hold didn't release: the open
 * hold-placing issues about them, and any open cause of a hold in force. Empty with no hold in force.
 */
export function withdrawalHoldPins(
  db: Database,
  input: { profileId: string },
): Promise<IssueView[]> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.status, 'open'),
          sql`EXISTS (
            SELECT 1 FROM withdrawal_holds h
             WHERE h.profile_id = ${input.profileId} AND h.released_at IS NULL)`,
          sql`(
            (${issues.kind} IN (${HOLD_KINDS_SQL})
              AND ${issues.subject}->>'profileId' = ${input.profileId})
            OR EXISTS (
              SELECT 1 FROM withdrawal_holds h
               WHERE h.issue_id = ${issues.id}
                 AND h.profile_id = ${input.profileId}
                 AND h.released_at IS NULL))`,
        ),
      )
      .orderBy(desc(issues.id))
      .limit(20);
    return rows.map(view);
  });
}

/** Open issues about the same tip, payout, page or person (for the evidence view). */
export function relatedOpenIssues(
  db: Database,
  issue: IssueView,
): Promise<IssueView[]> {
  const keys = (['tipId', 'payoutId', 'profileId', 'userId'] as const).filter(
    (key) => issue.subject[key],
  );
  if (keys.length === 0) return Promise.resolve([]);
  return guarded(async () => {
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.status, 'open'),
          sql`${issues.id} <> ${issue.id}`,
          sql`(${sql.join(
            keys.map(
              (key) => sql`${issues.subject}->>${key} = ${issue.subject[key]}`,
            ),
            sql` OR `,
          )})`,
        ),
      )
      .orderBy(desc(issues.id))
      .limit(20);
    return rows.map(view);
  });
}

/**
 * Staff resolve an open issue with a written reason (permission `issues.resolve`, audited). A money
 * issue also needs how it was settled, which is stored and changes no balance; the API also asks
 * `payouts.resolve` for one.
 */
/** By id or by mailbox: a second account on the same address is still the same person. */
async function isSamePerson(
  tx: Tx,
  actedBy: string | undefined,
  closingBy: string,
): Promise<boolean> {
  if (!actedBy) return false;
  const closer = canonicalId(closingBy);
  if (closer === actedBy) return true;
  if (!closer) return false;
  return sharesMailbox(
    await readMailboxes(tx, actedBy),
    await readMailboxes(tx, closer),
  );
}

export function resolveIssue(
  db: Database,
  input: {
    issueId: string;
    staffUserId: string;
    reason: string;
    outcome?: OpsIssueOutcome;
    bankAndSignInChecked?: boolean;
    now?: Date;
  },
): Promise<Partial<OpsFreezeReleased>> {
  if (!UUID.test(input.issueId))
    return Promise.reject(new OperationError('ISSUE_NOT_FOUND'));
  return guarded(() =>
    db.transaction(async (tx): Promise<Partial<OpsFreezeReleased>> => {
      const [current] = await tx
        .select({
          kind: issues.kind,
          severity: issues.severity,
          status: issues.status,
          subject: issues.subject,
        })
        .from(issues)
        .where(eq(issues.id, input.issueId));
      if (!current) throw new OperationError('ISSUE_NOT_FOUND');
      // Releasing a freeze sends the next withdrawal to the current bank, which may be the thief's.
      const takeover = current.kind === 'account_takeover_reported';
      if (
        current.status === 'open' &&
        (takeover
          ? input.outcome !== 'account_secured' ||
            input.bankAndSignInChecked !== true
          : input.outcome === 'account_secured')
      )
        throw new OperationError('ISSUE_OUTCOME_REQUIRED');
      if (
        current.status === 'open' &&
        (current.kind === 'staff_acted_alone' ||
          current.kind === 'staff_last_approver_removed') &&
        (await isSamePerson(tx, current.subject.userId, input.staffUserId))
      )
        throw new OperationError('ISSUE_OWN_ALERT');
      if (
        current.status === 'open' &&
        current.severity === 'money' &&
        !input.outcome
      )
        throw new OperationError('ISSUE_OUTCOME_REQUIRED');
      // Issues are never reopened and reconciliation won't raise the same one twice, so closing it
      // now would leave the money reserved with nobody told. The tools, or the payout ending, do it.
      if (current.status === 'open' && current.subject.payoutId) {
        const [payout] = await tx
          .select({ status: payouts.status })
          .from(payouts)
          .where(eq(payouts.id, current.subject.payoutId))
          .for('share');
        if (payout?.status === 'REQUESTED' || payout?.status === 'PROCESSING')
          throw new OperationError('ISSUE_PAYOUT_UNFINISHED');
      }
      const resolved = await markResolved(tx, {
        issueId: input.issueId,
        resolvedBy: input.staffUserId,
        staffUserId: input.staffUserId,
        reason: takeover
          ? `Current bank and sign-in checked. ${input.reason}`
          : input.reason,
        outcome: current.severity === 'money' ? input.outcome : undefined,
        now: input.now ?? new Date(),
      });
      if (!resolved) throw new OperationError('ISSUE_RESOLVED');
      if (!takeover) return {};
      // Closing it doesn't lift a hold another open issue placed, and staff must not say it does.
      const { profileId } = current.subject;
      const [held] = profileId
        ? await tx
            .select({ id: withdrawalHolds.id })
            .from(withdrawalHolds)
            .where(
              and(
                eq(withdrawalHolds.profileId, profileId),
                isNull(withdrawalHolds.releasedAt),
              ),
            )
            .limit(1)
        : [];
      const stillOpen = held
        ? await tx
            .select({ id: issues.id, kind: issues.kind })
            .from(issues)
            .where(
              and(
                eq(issues.status, 'open'),
                sql`${issues.kind} IN (${HOLD_KINDS_SQL})`,
                sql`${issues.subject}->>'profileId' = ${profileId}`,
              ),
            )
        : [];
      const withdrawals: OpsFreezeReleased['withdrawals'] = held
        ? 'still_held'
        : 'released';
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'withdrawals.freeze_lifted',
        permission: 'payouts.resolve',
        subjectType: 'issue',
        subjectId: input.issueId,
        reason: withdrawals,
        now: input.now,
      });
      // One person can lift a freeze, so it is never quiet.
      await enqueueOutbox(tx, {
        eventType: 'ops.freeze_released',
        aggregateId: input.issueId,
        payload: {
          action: 'freeze_released',
          outcome: withdrawals,
          targetId: input.issueId,
          requestedBy: input.staffUserId,
          // The page, so the relay can tell that page's open dashboards (live updates).
          ...(profileId ? { profileId } : {}),
        },
      });
      return { withdrawals, stillOpen };
    }),
  );
}

/** A staff note on an issue (append-only, audited). */
export function addIssueNote(
  db: Database,
  input: { issueId: string; staffUserId: string; text: string },
): Promise<{ id: string }> {
  if (!UUID.test(input.issueId))
    return Promise.reject(new OperationError('ISSUE_NOT_FOUND'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const [issue] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, input.issueId));
      if (!issue) throw new OperationError('ISSUE_NOT_FOUND');
      const id = newId();
      await tx.insert(issueNotes).values({
        id,
        issueId: input.issueId,
        staffUserId: input.staffUserId,
        text: input.text,
      });
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'issue.noted',
        permission: 'issues.view',
        subjectType: 'issue',
        subjectId: input.issueId,
      });
      return { id };
    }),
  );
}
