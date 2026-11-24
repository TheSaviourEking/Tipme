import {
  opsCollectEvidenceMaxFiles,
  type OpsCollectDispute,
  type OpsCollectDisputeDetail,
  type OpsCollectEvidenceState,
  type OpsCollectHeld,
  type OpsCollectReserve,
  type OpsCollectSameBank,
  type OpsCollectTransfer,
  type OpsCollectTransferStatus,
  type OpsCollectUnclaimed,
} from '@tipme/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { collectTransfers, disputes, issues, profiles } from '../schema.js';
import { recordAudit } from './audit.js';
import { collectStatus } from './collect-guards.js';
import { releaseHeldShare } from './collect-transfers.js';
import { sameBankHoldOpen, tellVerified } from './collect-verification.js';
import { lockDisputeTip, refundKeepsHold } from './disputes.js';
import { guarded, OperationError } from './errors.js';
import { listIssues, markResolved } from './issues.js';
import type { MailSealing } from './mail-queue.js';

/*
 * You collect staff screens (plan Task 15, spec §9). The reads show what TipMe holds, its transfers,
 * disputes and recipients past the holding cap, with today's masking: a handle, an amount, a state,
 * the last four digits of a bank account. Never a partner account, a full account number, or anything
 * about a supporter. The money actions below run inside serious actions (a second person), each
 * conditional on the state it was asked on, so each happens once.
 */

const DAY_MS = 86_400_000;
const LIST_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** Reminders sent to a recipient to add their bank details (Task 12's notices). */
const remindersSql = sql`(SELECT count(*)::int FROM notifications n
   WHERE n.user_id = p.user_id AND n.kind = 'collect_reminder')`;

/**
 * Money TipMe holds for recipients, from the ledger (`held_for_recipients`): per currency the total
 * is the ledger's own sum, so it always matches it; per recipient their amount, oldest tip, days
 * left before the holding cap pauses their page, reminders sent and whether it is paused.
 */
export function collectHeldMoney(
  db: Database,
  now: Date,
): Promise<OpsCollectHeld> {
  return guarded(async () => {
    const totals = await db.execute<{ currency: string; held: string }>(sql`
      SELECT a.currency,
             SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS held
        FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE a.code = 'held_for_recipients'
       GROUP BY a.currency ORDER BY a.currency`);
    const people = await db.execute<{
      profile_id: string;
      handle: string | null;
      currency: string;
      held: string;
      reminders: number;
      recheck_at: Date | null;
    }>(sql`
      SELECT h.profile_id, p.handle, h.currency, h.held::text AS held, ${remindersSql} AS reminders,
             p.collect_name_recheck_at AS recheck_at
        FROM (SELECT a.profile_id, a.currency,
                     SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) AS held
                FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
               WHERE a.code = 'held_for_recipients' AND a.profile_id IS NOT NULL
               GROUP BY a.profile_id, a.currency) h
        JOIN profiles p ON p.id = h.profile_id
       WHERE h.held <> 0
       ORDER BY h.held DESC, h.profile_id
       LIMIT ${LIST_LIMIT}`);
    const businesses = await db.execute<{
      business_id: string;
      name: string | null;
      currency: string;
      held: string;
    }>(sql`
      SELECT h.business_id, b.name, h.currency, h.held::text AS held
        FROM (SELECT a.business_id, a.currency,
                     SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) AS held
                FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
               WHERE a.code = 'held_for_recipients' AND a.business_id IS NOT NULL
               GROUP BY a.business_id, a.currency) h
        LEFT JOIN businesses b ON b.id = h.business_id
       WHERE h.held <> 0
       ORDER BY h.held DESC, h.business_id
       LIMIT ${LIST_LIMIT}`);
    const recipients = [];
    for (const row of people.rows) {
      const status = await collectStatus(db, row.profile_id, now);
      const pauseOn = status.pauseOn;
      recipients.push({
        profileId: row.profile_id,
        handle: row.handle,
        heldMinor: row.held,
        currency: row.currency,
        verified: status.verified,
        oldestTipAt: iso(status.firstWaitingAt),
        daysLeft:
          pauseOn && !status.verified
            ? Math.max(
                0,
                Math.ceil((pauseOn.getTime() - now.getTime()) / DAY_MS),
              )
            : null,
        remindersSent: row.reminders,
        paused: status.paused,
        pausedReason: status.pausedReason,
        nameRecheckSince: iso(row.recheck_at),
      });
    }
    return {
      totals: totals.rows.map((t) => ({
        currency: t.currency,
        heldMinor: t.held,
      })),
      recipients,
      businesses: businesses.rows.map((b) => ({
        businessId: b.business_id,
        name: b.name,
        heldMinor: b.held,
        currency: b.currency,
      })),
    };
  });
}

/** The collect transfers, newest first, optionally of one status. */
export function collectTransfersForStaff(
  db: Database,
  input: { status?: OpsCollectTransferStatus },
): Promise<OpsCollectTransfer[]> {
  return guarded(async () => {
    const result = await db.execute<{
      id: string;
      kind: OpsCollectTransfer['kind'];
      status: OpsCollectTransferStatus;
      review_reason: string | null;
      handle: string | null;
      amount_minor: string;
      currency: string;
      idempotency_key: string;
      last4: string | null;
      attempts: number;
      refused_at: Date | null;
      sent_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT c.id, c.kind, c.status, c.review_reason, p.handle, c.amount_minor::text AS amount_minor,
             c.currency, c.idempotency_key, c.attempts, c.refused_at, c.sent_at, c.created_at, c.updated_at,
             (SELECT d.account_last4 FROM payout_destinations d
               WHERE d.profile_id = c.profile_id AND d.provider = c.provider AND d.replaced_at IS NULL
               LIMIT 1) AS last4
        FROM collect_transfers c JOIN profiles p ON p.id = c.profile_id
       WHERE ${input.status ? sql`c.status = ${input.status}` : sql`TRUE`}
       ORDER BY c.created_at DESC, c.id
       LIMIT ${LIST_LIMIT}`);
    return result.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      reviewReason: r.review_reason,
      handle: r.handle,
      amountMinor: r.amount_minor,
      currency: r.currency,
      group: r.idempotency_key,
      bankLast4: r.last4,
      attempts: r.attempts,
      refused: r.refused_at !== null,
      sentAt: iso(r.sent_at),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    }));
  });
}

/** Recipients whose transfers a shared bank account holds: an open issue, or rows still in review. */
export function collectSameBankHolds(
  db: Database,
): Promise<OpsCollectSameBank[]> {
  return guarded(async () => {
    const result = await db.execute<{
      profile_id: string;
      handle: string | null;
      open_issues: number;
      held: number;
      held_minor: string;
      since: Date | null;
    }>(sql`
      SELECT p.id AS profile_id, p.handle,
             (SELECT count(*)::int FROM issues s WHERE s.kind = 'collect_same_bank' AND s.status = 'open'
                AND s.subject->>'profileId' = p.id::text) AS open_issues,
             (SELECT count(*)::int FROM collect_transfers c WHERE c.profile_id = p.id
                AND c.status = 'review' AND c.review_reason = 'same_bank') AS held,
             (SELECT COALESCE(SUM(c.amount_minor), 0)::text FROM collect_transfers c WHERE c.profile_id = p.id
                AND c.status = 'review' AND c.review_reason = 'same_bank') AS held_minor,
             (SELECT min(s.opened_at) FROM issues s WHERE s.kind = 'collect_same_bank'
                AND s.subject->>'profileId' = p.id::text AND s.status = 'open') AS since
        FROM profiles p
       WHERE EXISTS (SELECT 1 FROM issues s WHERE s.kind = 'collect_same_bank' AND s.status = 'open'
                       AND s.subject->>'profileId' = p.id::text)
          OR EXISTS (SELECT 1 FROM collect_transfers c WHERE c.profile_id = p.id
                       AND c.status = 'review' AND c.review_reason = 'same_bank')
       ORDER BY p.handle
       LIMIT ${LIST_LIMIT}`);
    return result.rows.map((r) => ({
      profileId: r.profile_id,
      handle: r.handle,
      openIssues: r.open_issues,
      heldTransfers: r.held,
      heldMinor: r.held_minor,
      since: iso(r.since),
    }));
  });
}

type DisputeRow = typeof disputes.$inferSelect;

function disputeView(
  row: DisputeRow,
  handle: string | null,
): OpsCollectDispute {
  return {
    id: row.id,
    handle,
    amountMinor: String(row.amountMinor),
    currency: row.currency,
    status: row.status as OpsCollectDispute['status'],
    reason: row.reason,
    respondBy: iso(row.respondBy),
    evidenceState: row.evidenceState as OpsCollectEvidenceState,
    heldMinor: String(row.heldMinor),
    settledAt: iso(row.settledAt),
    createdAt: iso(row.createdAt)!,
  };
}

/** Disputes on collect tips, open ones first, then newest. */
export function collectDisputesForStaff(
  db: Database,
): Promise<OpsCollectDispute[]> {
  return guarded(async () => {
    const rows = await db.execute<{ id: string; handle: string | null }>(sql`
      SELECT x.id, p.handle FROM disputes x
        JOIN tips t ON t.id = x.tip_id LEFT JOIN profiles p ON p.id = t.profile_id
       ORDER BY (x.status IN ('open', 'responded')) DESC, x.created_at DESC, x.id
       LIMIT ${LIST_LIMIT}`);
    if (rows.rows.length === 0) return [];
    const full = await db
      .select()
      .from(disputes)
      .where(
        inArray(
          disputes.id,
          rows.rows.map((r) => r.id),
        ),
      );
    const byId = new Map(full.map((d) => [d.id, d]));
    return rows.rows.flatMap((r) => {
      const row = byId.get(r.id);
      return row ? [disputeView(row, r.handle)] : [];
    });
  });
}

/** Whether evidence may be added and sent for this dispute now. */
function evidenceOpen(row: DisputeRow, now: Date) {
  const late =
    row.respondBy !== null && row.respondBy.getTime() <= now.getTime();
  const canSubmit =
    row.status === 'open' &&
    !late &&
    (row.evidenceState === 'none' ||
      row.evidenceState === 'draft' ||
      row.evidenceState === 'refused');
  return { late, canSubmit };
}

/** Why a closed dispute's hold can't be released now, or null when it can (P28). */
async function holdReleaseRefusal(
  tx: Database | Tx,
  row: DisputeRow,
): Promise<string | null> {
  if (row.status !== 'closed')
    return 'Only a dispute closed without a ruling keeps its hold for a refund.';
  if (row.settledAt) return 'Its hold has already been released or used.';
  if (row.shareStep === null)
    return 'Its share is still being read back. Try again once it settles.';
  if (await refundKeepsHold(tx as Tx, row.tipId))
    return 'A refund of this tip is in progress, or one has used the hold.';
  return null;
}

/** One dispute, with the evidence state from TipMe's records and whether its hold can be released. */
export function collectDisputeForStaff(
  db: Database,
  input: { disputeId: string; now: Date },
): Promise<OpsCollectDisputeDetail | null> {
  if (!UUID.test(input.disputeId)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select()
      .from(disputes)
      .where(eq(disputes.id, input.disputeId));
    if (!row) return null;
    const handle = await db.execute<{ handle: string | null }>(sql`
      SELECT p.handle FROM tips t LEFT JOIN profiles p ON p.id = t.profile_id WHERE t.id = ${row.tipId}`);
    const refusal = await holdReleaseRefusal(db, row);
    const { late, canSubmit } = evidenceOpen(row, input.now);
    return {
      ...disputeView(row, handle.rows[0]?.handle ?? null),
      partnerDisputeId: row.partnerDisputeId,
      shareStep: row.shareStep as OpsCollectDisputeDetail['shareStep'],
      decidedAt: iso(row.decidedAt),
      feeMinor: row.feeMinor === null ? null : String(row.feeMinor),
      feeCurrency: row.feeCurrency,
      evidence: {
        state: row.evidenceState as OpsCollectEvidenceState,
        files: row.evidenceFiles.map(({ contentType, bytes }) => ({
          contentType,
          bytes,
        })),
        askedAt: iso(row.evidenceAskedAt),
        submittedAt: iso(row.evidenceSubmittedAt),
        canSubmit,
        late,
        maxFiles: opsCollectEvidenceMaxFiles(row.provider),
      },
      holdRelease: { possible: refusal === null, why: refusal },
    };
  });
}

/** Recipients past the holding cap (spec §15): listed for staff, nothing happens to them. */
export function collectUnclaimed(
  db: Database,
  now: Date,
): Promise<OpsCollectUnclaimed[]> {
  return guarded(async () => {
    const candidates = await db.execute<{
      id: string;
      handle: string | null;
      reminders: number;
    }>(sql`
      SELECT p.id, p.handle, ${remindersSql} AS reminders FROM profiles p
       WHERE p.id IN (SELECT profiles.id FROM profiles WHERE ${profiles.collectionMode} = 'collect')
         AND p.collect_verified_at IS NULL
         AND EXISTS (SELECT 1 FROM collect_transfers c WHERE c.profile_id = p.id AND c.kind = 'share'
                       AND c.status IN ('waiting', 'ready', 'sent', 'unknown', 'review'))
       ORDER BY p.handle
       LIMIT ${LIST_LIMIT}`);
    const out: OpsCollectUnclaimed[] = [];
    for (const row of candidates.rows) {
      const status = await collectStatus(db, row.id, now);
      if (!status.pausedReason) continue;
      out.push({
        profileId: row.id,
        handle: row.handle,
        heldMinor: String(status.heldMinor),
        currency: 'NGN',
        oldestTipAt: iso(status.firstWaitingAt),
        pausedReason: status.pausedReason,
        remindersSent: row.reminders,
      });
    }
    return out;
  });
}

/* Money actions, each run in its serious action's transaction. */

/**
 * P28: a dispute closed without a ruling keeps its hold for a refund, and releases it by itself
 * after 14 days if none uses it. Staff release it sooner, once: refused while a refund of the tip is
 * in flight or has used the hold (or money already went back). Releasing changes no posting: the
 * hold is a reservation (R4), never a ledger entry, so the books stay as they are.
 */
export async function releaseDisputeHold(
  tx: Tx,
  input: { disputeId: string; now: Date },
): Promise<{ disputeId: string; releasedMinor: string }> {
  if (!UUID.test(input.disputeId))
    throw new OperationError('COLLECT_ACTION_REFUSED', 'no_dispute');
  // Fix round 1 (I1): the tip first, as askTipRefund locks it, so a refund asked at the same time
  // either commits before this reads it (and the release is refused) or waits for it.
  await lockDisputeTip(tx, input.disputeId);
  const [row] = await tx
    .select()
    .from(disputes)
    .where(eq(disputes.id, input.disputeId))
    .for('update');
  if (!row) throw new OperationError('COLLECT_ACTION_REFUSED', 'no_dispute');
  const refusal = await holdReleaseRefusal(tx, row);
  if (refusal) throw new OperationError('COLLECT_ACTION_REFUSED', refusal);
  let released = row.heldMinor;
  if (row.shareStep === 'held') {
    const [share] = await tx
      .select()
      .from(collectTransfers)
      .where(
        and(
          eq(collectTransfers.tipId, row.tipId),
          eq(collectTransfers.kind, 'share'),
        ),
      );
    if (share) {
      // Closed: its hold was handed to the refund (closeWithoutRuling); one asked before that
      // hand-over still holds it for the dispute.
      const freed =
        (await releaseHeldShare(tx, {
          transferId: share.id,
          reason: 'refund',
          now: input.now,
        })) ||
        (await releaseHeldShare(tx, {
          transferId: share.id,
          reason: 'dispute',
          now: input.now,
        }));
      if (freed) released = share.amountMinor;
    }
  }
  const [settled] = await tx
    .update(disputes)
    .set({ heldMinor: 0n, settledAt: input.now, updatedAt: input.now })
    .where(and(eq(disputes.id, row.id), isNull(disputes.settledAt)))
    .returning({ id: disputes.id });
  if (!settled) throw new OperationError('COLLECT_ACTION_REFUSED', 'settled');
  return { disputeId: row.id, releasedMinor: String(released) };
}

/** What a same-bank clear is pinned on: the open issues and held rows, as they stand. */
export async function sameBankStamp(
  tx: Database | Tx,
  profileId: string,
): Promise<{ issues: string[]; held: string[] }> {
  const open = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.kind, 'collect_same_bank'),
        eq(issues.status, 'open'),
        sql`${issues.subject}->>'profileId' = ${profileId}`,
      ),
    );
  const held = await tx
    .select({ id: collectTransfers.id })
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.profileId, profileId),
        eq(collectTransfers.status, 'review'),
        eq(collectTransfers.reviewReason, 'same_bank'),
      ),
    );
  return {
    issues: open.map((r) => r.id).sort(),
    held: held.map((r) => r.id).sort(),
  };
}

/**
 * Task 13 M3: staff checked a bank account shared by two recipients and clear the hold. Every open
 * `collect_same_bank` issue for this recipient is resolved and their transfers held for it go back
 * to the queue (`ready` with their account, `waiting` without), once. Only now, if they are verified,
 * are they told their tips are on their way (the notice verification held back).
 */
export async function clearSameBankHold(
  tx: Tx,
  input: {
    profileId: string;
    staffUserId: string;
    reason: string;
    sealing?: MailSealing | undefined;
    now: Date;
  },
): Promise<{ released: number; resolved: number }> {
  if (!UUID.test(input.profileId))
    throw new OperationError('COLLECT_ACTION_REFUSED', 'no_profile');
  const [profile] = await tx
    .select({
      verifiedAt: profiles.collectVerifiedAt,
      recheckAt: profiles.collectNameRecheckAt,
    })
    .from(profiles)
    .where(eq(profiles.id, input.profileId))
    .for('update');
  if (!profile)
    throw new OperationError('COLLECT_ACTION_REFUSED', 'no_profile');
  const stamp = await sameBankStamp(tx, input.profileId);
  if (stamp.issues.length === 0 && stamp.held.length === 0)
    throw new OperationError('COLLECT_ACTION_REFUSED', 'nothing_held');
  let resolved = 0;
  for (const issueId of stamp.issues)
    if (
      await markResolved(tx, {
        issueId,
        resolvedBy: input.staffUserId,
        staffUserId: input.staffUserId,
        reason: input.reason,
        now: input.now,
      })
    )
      resolved += 1;
  const released = await tx
    .update(collectTransfers)
    .set({
      status: sql`CASE WHEN ${collectTransfers.accountReference} IS NULL THEN 'waiting' ELSE 'ready' END`,
      reviewReason: null,
      nextTryAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(collectTransfers.profileId, input.profileId),
        eq(collectTransfers.status, 'review'),
        eq(collectTransfers.reviewReason, 'same_bank'),
        isNull(collectTransfers.sentAt),
      ),
    )
    .returning({ id: collectTransfers.id });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'collect_same_bank.cleared',
    permission: 'collect.manage',
    subjectType: 'profile',
    subjectId: input.profileId,
    reason: input.reason,
    now: input.now,
  });
  if (
    profile.verifiedAt &&
    profile.recheckAt === null &&
    !(await sameBankHoldOpen(tx, input.profileId))
  )
    await tellVerified(tx, {
      profileId: input.profileId,
      sealing: input.sealing,
      now: input.now,
    });
  return { released: released.length, resolved };
}

/** What a dispute evidence request is pinned on. */
export async function disputeEvidenceStamp(
  tx: Database | Tx,
  disputeId: string,
): Promise<{ state: string; attempt: number; files: number } | null> {
  if (!UUID.test(disputeId)) return null;
  const [row] = await tx
    .select({
      state: disputes.evidenceState,
      attempt: disputes.evidenceAttempt,
      files: disputes.evidenceFiles,
    })
    .from(disputes)
    .where(eq(disputes.id, disputeId));
  return row
    ? { state: row.state, attempt: row.attempt, files: row.files.length }
    : null;
}

/** A dispute staff act on, or a refusal. */
async function lockedDispute(tx: Tx, disputeId: string): Promise<DisputeRow> {
  if (!UUID.test(disputeId))
    throw new OperationError('COLLECT_ACTION_REFUSED', 'no_dispute');
  const [row] = await tx
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .for('update');
  if (!row) throw new OperationError('COLLECT_ACTION_REFUSED', 'no_dispute');
  return row;
}

/**
 * An evidence file the partner accepted for this dispute (uploaded by the route first; a file is
 * not money and a lost upload is only uploaded again). Five at most; only while evidence is open.
 */
export function addDisputeEvidenceFile(
  db: Database,
  input: {
    disputeId: string;
    fileRef: string;
    contentType: string;
    bytes: number;
    staffUserId: string;
    now: Date;
  },
): Promise<{ files: number }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockedDispute(tx, input.disputeId);
      const { late, canSubmit } = evidenceOpen(row, input.now);
      if (late) throw new OperationError('COLLECT_EVIDENCE_LATE');
      if (!canSubmit)
        throw new OperationError('COLLECT_ACTION_REFUSED', 'evidence_closed');
      // Fix round 1 (C1): the provider's own limit, under the lock (one file at Bachs).
      if (row.evidenceFiles.length >= opsCollectEvidenceMaxFiles(row.provider))
        throw new OperationError('COLLECT_ACTION_REFUSED', 'evidence_full');
      const files = [
        ...row.evidenceFiles,
        {
          fileRef: input.fileRef,
          contentType: input.contentType,
          bytes: input.bytes,
        },
      ];
      await tx
        .update(disputes)
        .set({
          evidenceFiles: files,
          evidenceState: 'draft',
          updatedAt: input.now,
        })
        .where(eq(disputes.id, row.id));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'collect_dispute.file_added',
        permission: 'collect.manage',
        subjectType: 'dispute',
        subjectId: row.id,
        now: input.now,
      });
      return { files: files.length };
    }),
  );
}

/**
 * Fix round 1 (C1): a file added by mistake comes off before the evidence is sent, so the right one
 * can replace it (the partner keeps the unused document; nothing references it). One person, with a
 * reason, audited; only while evidence is open.
 */
export function removeDisputeEvidenceFile(
  db: Database,
  input: {
    disputeId: string;
    index: number;
    staffUserId: string;
    reason: string;
    now: Date;
  },
): Promise<{ files: number }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockedDispute(tx, input.disputeId);
      const { late, canSubmit } = evidenceOpen(row, input.now);
      if (late) throw new OperationError('COLLECT_EVIDENCE_LATE');
      if (
        !canSubmit ||
        !Number.isInteger(input.index) ||
        input.index < 0 ||
        input.index >= row.evidenceFiles.length
      )
        throw new OperationError('COLLECT_ACTION_REFUSED', 'no_file');
      const files = row.evidenceFiles.filter((_, i) => i !== input.index);
      await tx
        .update(disputes)
        .set({
          evidenceFiles: files,
          evidenceState:
            files.length > 0
              ? 'draft'
              : row.evidenceState === 'refused'
                ? 'refused'
                : 'none',
          updatedAt: input.now,
        })
        .where(eq(disputes.id, row.id));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'collect_dispute.file_removed',
        permission: 'collect.manage',
        subjectType: 'dispute',
        subjectId: row.id,
        reason: input.reason,
        now: input.now,
      });
      return { files: files.length };
    }),
  );
}

/** A dispute, for its evidence route: the provider and partner id the upload needs. */
export async function disputeForEvidence(
  db: Database,
  disputeId: string,
  now: Date,
): Promise<{
  provider: string;
  partnerDisputeId: string;
  late: boolean;
  canSubmit: boolean;
  files: number;
} | null> {
  if (!UUID.test(disputeId)) return null;
  const [row] = await guarded(() =>
    db.select().from(disputes).where(eq(disputes.id, disputeId)),
  );
  if (!row) return null;
  return {
    provider: row.provider,
    partnerDisputeId: row.partnerDisputeId,
    ...evidenceOpen(row, now),
    files: row.evidenceFiles.length,
  };
}

/**
 * Staff's evidence, approved: recorded for the worker to submit once (`sending`, the next attempt's
 * key). Refused after the deadline, on a dispute no longer open, or once already sent or submitted.
 */
export async function askDisputeEvidence(
  tx: Tx,
  input: { disputeId: string; text: string; now: Date },
): Promise<{ disputeId: string; state: 'sending' }> {
  const row = await lockedDispute(tx, input.disputeId);
  const { late, canSubmit } = evidenceOpen(row, input.now);
  if (late) throw new OperationError('COLLECT_EVIDENCE_LATE');
  if (!canSubmit)
    throw new OperationError('COLLECT_ACTION_REFUSED', 'evidence_closed');
  const text = input.text.trim();
  if (text.length < 20 || text.length > 5000)
    throw new OperationError('INVALID_INPUT');
  await tx
    .update(disputes)
    .set({
      evidenceText: text,
      evidenceState: 'sending',
      evidenceAttempt: row.evidenceAttempt + 1,
      evidenceAskedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(disputes.id, row.id));
  return { disputeId: row.id, state: 'sending' };
}

/** The evidence call the worker needs (Task 5's adapter and the mock). Structural, as ADR-0004. */
export interface DisputeEvidenceProvider {
  submitDisputeEvidence(input: {
    partnerDisputeId: string;
    text: string;
    fileRefs: string[];
    idempotencyKey: string;
  }): Promise<{ state: 'submitted' }>;
}

/** The key one evidence attempt is sent under: a repeat of it submits once at the partner. */
export const disputeEvidenceKey = (disputeId: string, attempt: number) =>
  `tipme-dispute-evidence-${disputeId}-${attempt}`;

/**
 * The worker's step (every 2 minutes, with the transfer sweep): evidence approved for this
 * provider is submitted, once per attempt's key. Submitted or refused (a definite refusal: nothing
 * was submitted) is recorded; anything else is unknown and asked again next time with the same key,
 * which the partner answers with the same outcome.
 */
export function sendDisputeEvidence(
  db: Database,
  input: {
    provider: DisputeEvidenceProvider;
    providerName: string;
    now: Date;
  },
): Promise<{ submitted: number; refused: number; failed: number }> {
  return guarded(async () => {
    const due = await db
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.evidenceState, 'sending'),
          eq(disputes.provider, input.providerName),
        ),
      )
      .limit(20);
    const totals = { submitted: 0, refused: 0, failed: 0 };
    for (const row of due) {
      let outcome: 'submitted' | 'refused';
      try {
        await input.provider.submitDisputeEvidence({
          partnerDisputeId: row.partnerDisputeId,
          text: row.evidenceText ?? '',
          fileRefs: row.evidenceFiles.map((f) => f.fileRef),
          idempotencyKey: disputeEvidenceKey(row.id, row.evidenceAttempt),
        });
        outcome = 'submitted';
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'DisputeEvidenceRefusedError' ||
            error.name === 'BachsRequestNotSentError')
        )
          outcome = 'refused';
        else {
          totals.failed += 1;
          continue;
        }
      }
      await db
        .update(disputes)
        .set(
          outcome === 'submitted'
            ? {
                evidenceState: 'submitted',
                evidenceSubmittedAt: input.now,
                updatedAt: input.now,
              }
            : { evidenceState: 'refused', updatedAt: input.now },
        )
        .where(
          and(
            eq(disputes.id, row.id),
            eq(disputes.evidenceState, 'sending'),
            eq(disputes.evidenceAttempt, row.evidenceAttempt),
          ),
        );
      totals[outcome] += 1;
    }
    return totals;
  });
}

/** What a transfer action is pinned on. */
export async function collectTransferStamp(
  tx: Database | Tx,
  transferId: string,
): Promise<{ status: string; reason: string | null; attempts: number } | null> {
  if (!UUID.test(transferId)) return null;
  const [row] = await tx
    .select({
      status: collectTransfers.status,
      reason: collectTransfers.reviewReason,
      attempts: collectTransfers.attempts,
    })
    .from(collectTransfers)
    .where(eq(collectTransfers.id, transferId));
  return row ?? null;
}

/**
 * Staff hold a transfer for a manual check ("send to review", P13 `staff`): only one never sent
 * (holdCollectTransfer's rule). One person with a reason and a fresh code: it only stops money.
 */
export function holdTransferForReview(
  db: Database,
  input: { transferId: string; staffUserId: string; reason: string; now: Date },
): Promise<boolean> {
  if (!UUID.test(input.transferId)) return Promise.resolve(false);
  return guarded(() =>
    db.transaction(async (tx) => {
      const held = await tx
        .update(collectTransfers)
        .set({ status: 'review', reviewReason: 'staff', updatedAt: input.now })
        .where(
          and(
            eq(collectTransfers.id, input.transferId),
            inArray(collectTransfers.status, ['waiting', 'ready']),
            isNull(collectTransfers.sentAt),
          ),
        )
        .returning({ id: collectTransfers.id });
      if (held.length !== 1) return false;
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'collect_transfer.held',
        permission: 'collect.manage',
        subjectType: 'collect_transfer',
        subjectId: input.transferId,
        reason: input.reason,
        now: input.now,
      });
      return true;
    }),
  );
}

/** Staff retry a transfer in review (P13, P20), in the serious action's transaction. */
export async function retryTransferInReview(
  tx: Tx,
  input: { transferId: string; now: Date },
): Promise<{ transferId: string; status: 'ready' | 'waiting' }> {
  if (!UUID.test(input.transferId))
    throw new OperationError('COLLECT_ACTION_REFUSED', 'no_transfer');
  const [moved] = await tx
    .update(collectTransfers)
    .set({
      status: sql`CASE WHEN ${collectTransfers.accountReference} IS NULL THEN 'waiting' ELSE 'ready' END`,
      reviewReason: null,
      refusedAt: null,
      nextTryAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(collectTransfers.id, input.transferId),
        eq(collectTransfers.status, 'review'),
        inArray(collectTransfers.reviewReason, ['provider', 'staff']),
      ),
    )
    .returning({ status: collectTransfers.status });
  if (!moved)
    throw new OperationError('COLLECT_ACTION_REFUSED', 'not_in_review');
  return {
    transferId: input.transferId,
    status: moved.status === 'ready' ? 'ready' : 'waiting',
  };
}

/** The profile behind a handle, for support's name change. Null when there is none. */
export async function profileIdByHandle(
  db: Database,
  handle: string,
): Promise<string | null> {
  const [row] = await guarded(() =>
    db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        eq(profiles.handleLower, handle.trim().replace(/^@/, '').toLowerCase()),
      ),
  );
  return row?.id ?? null;
}

const RESERVE_LEVEL: Record<
  string,
  OpsCollectReserve['currencies'][number]['level']
> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
  breach: 'broken',
};
const SCHEDULE_STATES: ReadonlySet<string> = new Set([
  'manual',
  'auto',
  'unread',
  'not_checked',
]);
const RESERVE_ISSUES = [
  'collect_invariant_broken',
  'collect_auto_payout_on',
  'collect_own_money_wait',
] as const;

/**
 * Task 15 follow-up: the reserve page. Task 11's latest reading per provider and currency (what the
 * partner's balance had available, what TipMe holds for recipients, TipMe's own money and its level),
 * whether automatic payouts were on at the latest check, and the open reserve issues. Reads only.
 */
export function collectReserveForStaff(
  db: Database,
): Promise<OpsCollectReserve> {
  return guarded(async () => {
    const readings = await db.execute<{
      provider: string;
      currency: string;
      available: string | null;
      held: string;
      own: string | null;
      level: string | null;
      warning: string;
      critical: string;
      read_at: Date;
    }>(sql`
      SELECT DISTINCT ON (provider, currency)
             provider, currency, available_minor::text AS available, held_minor::text AS held,
             own_minor::text AS own, level, warning_minor::text AS warning,
             critical_minor::text AS critical, read_at
        FROM collect_reserve_readings
       ORDER BY provider, currency, read_at DESC, id`);
    const autoPayouts = await db.execute<{
      provider: string;
      active: boolean;
      detail: string | null;
      read_at: Date;
    }>(sql`
      SELECT DISTINCT ON (provider) provider, active, detail, read_at
        FROM collect_reserve_alerts
       WHERE condition = 'auto_payout'
       ORDER BY provider, read_at DESC, id`);
    const open = (
      await Promise.all(
        RESERVE_ISSUES.map((kind) =>
          listIssues(db, { status: 'open', kind, limit: 20 }),
        ),
      )
    ).flat();
    return {
      currencies: readings.rows.map((r) => ({
        provider: r.provider,
        currency: r.currency,
        availableMinor: r.available,
        heldMinor: r.held,
        ownMinor: r.own,
        level: r.level ? (RESERVE_LEVEL[r.level] ?? 'unknown') : 'unknown',
        warningMinor: r.warning,
        criticalMinor: r.critical,
        readAt: iso(r.read_at)!,
      })),
      autoPayouts: autoPayouts.rows.map((r) => ({
        provider: r.provider,
        // I1: what the read found. A row from before it was recorded says only whether it was on:
        // on stays on, and anything else is not claimed to be off.
        state: SCHEDULE_STATES.has(r.detail ?? '')
          ? (r.detail as OpsCollectReserve['autoPayouts'][number]['state'])
          : r.active
            ? 'auto'
            : 'unread',
        readAt: iso(r.read_at)!,
      })),
      issues: open.map((issue) => ({
        id: issue.id,
        kind: issue.kind,
        openedAt: iso(issue.openedAt)!,
        summary: issue.summary,
      })),
    };
  });
}
