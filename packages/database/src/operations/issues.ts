import type { OpsIssue } from '@tipme/contracts';
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
  type IssueKind,
  type IssueSeverity,
  type IssueSubject,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';

const STUCK_AFTER_MS = 30 * 60 * 1000;

/** Outbox alerts that need a person, and the issue kind each becomes. */
const EVENT_KINDS: Record<string, IssueKind> = {
  'payment.mismatch': 'payment_mismatch',
  'payment.conflict': 'payment_conflict',
  'payment.unresolved': 'payment_unresolved',
  'payment.reversed': 'payment_reversed',
  'payout.failed': 'payout_failed',
  'payout.conflict': 'payout_conflict',
  'provider_event.conflict': 'provider_event_conflict',
};
export const ISSUE_EVENT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(EVENT_KINDS),
);

const SEVERITY: Record<IssueKind, IssueSeverity> = {
  payment_mismatch: 'money',
  payment_conflict: 'money',
  payment_unresolved: 'money',
  payment_attempt_unresolved: 'money',
  payment_account_unresolved: 'account',
  payment_reversed: 'money',
  payout_failed: 'money',
  payout_conflict: 'money',
  provider_event_conflict: 'money',
  stuck_tip: 'info',
  unmatched_event: 'info',
  pending_recovery: 'account',
  message_reported: 'account',
  profile_reported: 'account',
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
    case 'payment_reversed':
      return `Bachs reported a refund or dispute on a paid tip to ${page}. TipMe changed no balance: review it in Bachs Dashboard.`;
    case 'payout_failed':
      return `A withdrawal for ${page} failed. The money is back in their balance.`;
    case 'payout_conflict':
      return `The provider says a withdrawal for ${page} was paid after TipMe recorded it as failed.`;
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
    case 'pending_recovery':
      return `Someone asked to move ${handle ? `@${handle}’s` : 'an'} account to a new number by email recovery. It waits 24 hours.`;
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
    if (row) filled.profileId = row.profileId;
  }
  if (filled.payoutId && !filled.profileId) {
    const [row] = await tx
      .select({ profileId: payouts.profileId })
      .from(payouts)
      .where(eq(payouts.id, filled.payoutId));
    if (row) filled.profileId = row.profileId;
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
  },
): Promise<boolean> {
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
      summary: summaryOf(input.kind, handle),
      openedAt: input.now,
      rehearsal,
    })
    .onConflictDoNothing({ target: issues.dedupeKey })
    .returning({ id: issues.id });
  return inserted.length > 0;
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
  return guarded(async () =>
    (await openIssue(db, {
      dedupeKey: `event.${input.dedupeKey}`,
      kind,
      subject,
      now: input.now ?? new Date(),
    }))
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
        await openIssue(db, {
          dedupeKey: `stuck_tip.${row.id}`,
          kind: 'stuck_tip',
          subject: { tipId: row.id },
          now,
        })
      )
        opened += 1;
    const unmatched = await db.execute<{ id: string }>(sql`
      SELECT u.id FROM unmatched_provider_events u
       WHERE NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'unmatched.' || u.id)
       LIMIT 500`);
    for (const row of unmatched.rows)
      if (
        await openIssue(db, {
          dedupeKey: `unmatched.${row.id}`,
          kind: 'unmatched_event',
          subject: { unmatchedId: row.id },
          now,
        })
      )
        opened += 1;
    const unknownAccounts = await db
      .select({ id: paymentAccounts.id, profileId: paymentAccounts.profileId })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.environment, 'sandbox'),
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
        await openIssue(db, {
          dedupeKey: `payment_account_unresolved.${row.id}`,
          kind: 'payment_account_unresolved',
          subject: { profileId: row.profileId },
          now,
        })
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
        await openIssue(db, {
          dedupeKey: `payment_attempt_unresolved.${row.id}`,
          kind: 'payment_attempt_unresolved',
          subject: { attemptId: row.id, tipId: row.tipId },
          now,
        })
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
        await openIssue(db, {
          dedupeKey: `recovery.${row.id}`,
          kind: 'pending_recovery',
          subject: { recoveryId: row.id, userId: row.userId },
          now,
        })
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
    now: Date;
  },
): Promise<boolean> {
  const updated = await tx
    .update(issues)
    .set({
      status: 'resolved',
      resolvedAt: input.now,
      resolvedBy: input.resolvedBy,
    })
    .where(and(eq(issues.id, input.issueId), eq(issues.status, 'open')))
    .returning({ id: issues.id });
  if (updated.length === 0) return false;
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: input.staffUserId ? 'issue.resolved' : 'issue.auto_resolved',
    permission: input.staffUserId ? 'issues.resolve' : undefined,
    subjectType: 'issue',
    subjectId: input.issueId,
    reason: input.reason,
    now: input.now,
  });
  return true;
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
       WHERE i.status = 'open' AND i.kind = 'payment_attempt_unresolved'
         AND a.status IN ('VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED')
      UNION ALL
      SELECT i.id, 'The Bachs recipient account was found and its status was synchronized.'
        FROM issues i
        JOIN payment_accounts a
          ON a.profile_id = (i.subject->>'profileId')::uuid
         AND a.provider = 'bachs'
         AND a.environment = 'sandbox'
       WHERE i.status = 'open' AND i.kind = 'payment_account_unresolved'
         AND a.status <> 'UNKNOWN'
         AND a.provider_account_reference IS NOT NULL
      UNION ALL
      -- Raised after its release check finished (the misreported tip never confirms).
      SELECT i.id, 'The release check that raised it has finished.'
        FROM issues i
        JOIN profiles p ON p.id = (i.subject->>'profileId')::uuid
        JOIN release_runs r ON r.id = p.rehearsal_run_id
       WHERE i.status = 'open' AND i.rehearsal AND r.finished_at IS NOT NULL
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
            ? lt(issues.id, input.cursor)
            : undefined,
        ),
      )
      .orderBy(desc(issues.id))
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

/** Staff resolve an open issue with a written reason (permission `issues.resolve`, audited). */
export function resolveIssue(
  db: Database,
  input: { issueId: string; staffUserId: string; reason: string; now?: Date },
): Promise<void> {
  if (!UUID.test(input.issueId))
    return Promise.reject(new OperationError('ISSUE_NOT_FOUND'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const resolved = await markResolved(tx, {
        issueId: input.issueId,
        resolvedBy: input.staffUserId,
        staffUserId: input.staffUserId,
        reason: input.reason,
        now: input.now ?? new Date(),
      });
      if (resolved) return;
      const [row] = await tx
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, input.issueId));
      throw new OperationError(row ? 'ISSUE_RESOLVED' : 'ISSUE_NOT_FOUND');
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
