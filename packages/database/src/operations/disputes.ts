import { createHash } from 'node:crypto';
import { DISPUTE_HOLD_EVENT } from '@tipme/contracts';
import {
  buildDisputeFeePosting,
  buildDisputeLossPosting,
  disputeRecovery,
  disputeStatusAfter,
  type DisputeStatus,
} from '@tipme/domain';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  collectTransfers,
  disputes,
  shareTransfers,
  ledgerTransactions,
  notifications,
  paymentAttempts,
  profiles,
  providerEvents,
  tips,
} from '../schema.js';
import { balanceIn } from './balance.js';
import {
  matchCollectAttempt,
  reduceUnsentShare,
  releaseHeldShare,
  sharePosition,
  takeUnsentShare,
  type SharePosition,
} from './collect-transfers.js';

type CollectTransferRow = typeof collectTransfers.$inferSelect;
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { jsonSafe } from './provider-events.js';

/*
 * You collect (plan Task 9, spec §6.2, R4, R6, P13, P14, P20, P27). A dispute on a tip TipMe
 * collected is TipMe's: the partner charges TipMe's account. Each partner event is stored once and
 * folded into one `disputes` row (out-of-order safe: `disputeStatusAfter`). Then the dispute is
 * advanced as far as it can go:
 *
 *   open      the share is held: proven unmoved (never sent, or its last send definitely refused)
 *             → `review` (reason `dispute`); moved → that amount of the recipient's balance
 *             (`held_minor`, R4) and a notice; in flight → nothing until its read-back settles it
 *             (Review Focus 3, P26), then one of those. A business's share still in TipMe's balance
 *             (its `collect_sweep`) is not sent while the dispute is unsettled (R3).
 *   won       the hold is released (P20); the fee stays an expense.
 *   closed    no ruling (the partner's `prevented` reads as closed: the supporter got their money
 *             back by refund, which the refund event books). No loss, no notice, and no release
 *             that would pay the same money twice: the hold is kept for the refund (P28; Task 10
 *             releases or consumes it) and staff are told. With no refund for the tip after
 *             CLOSED_HOLD_KEPT_MS it is released and the dispute settled.
 *   lost      recovered from what TipMe still holds or can take back first (disputeRecovery): the
 *             person's held share is cancelled (or reduced), or a `back` transfer takes what is still
 *             in their account (the transfer machine sends it); then the business's unswept share;
 *             then the loss is booked (`dispute_loss.<id>`, a reversal of the payment) and TipMe
 *             absorbs the rest. A business share already swept is absorbed and raised to staff.
 *             Nothing changes unless the loss can be booked in the payment's currency. Waiting a
 *             day on money in flight raises `dispute_waiting.<id>`.
 *
 * Every step is conditional and idempotent; the transfer sweep (`runDisputeSteps`) retries what
 * could not be done yet. The partner documents no dispute fee field, so a fee is booked only when
 * one is reported, in its currency; otherwise `dispute_fee_unposted` asks staff (R6). Never $15 on a
 * guess.
 */

/** The partner's dispute event as the adapter normalises it (Task 5). Structural, as ADR-0004. */
export interface CollectDisputeEvent {
  eventId: string;
  eventType: string;
  partnerDisputeId: string;
  chargeReference: string | null;
  providerReference: string | null;
  operationReference: string | null;
  status: DisputeStatus;
  amountMinor: bigint;
  currency: string;
  reason: string | null;
  respondBy: Date | null;
  feeMinor: bigint | null;
  feeCurrency: string | null;
  occurredAt: Date;
}

export type DisputeOutcome =
  'opened' | 'updated' | 'won' | 'lost' | 'duplicate' | 'unmatched' | 'stale';

type DisputeRow = typeof disputes.$inferSelect;

/** How long before evidence is due staff get a reminder. */
const DEADLINE_NOTICE_MS = 48 * 3_600_000;
/**
 * A closed dispute's hold is kept this long for the refund that may book it (P28: Task 10 releases
 * or consumes it); with no refund for the tip by then, it is released.
 */
export const CLOSED_HOLD_KEPT_MS = 14 * 24 * 3_600_000;
/** A lost dispute waiting this long on a transfer in flight is raised to staff. */
const LOST_WAITING_ALERT_MS = 24 * 3_600_000;
const SWEEP_LIMIT = 100;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** "₦9,500", or "₦9,500.50" with kobo: as the mail templates write naira. */
function naira(minor: bigint): string {
  const kobo = minor % 100n;
  const whole = new Intl.NumberFormat('en').format(minor / 100n);
  return `₦${whole}${kobo === 0n ? '' : `.${String(kobo).padStart(2, '0')}`}`;
}

/** The spec's words (§10), with the amount held. */
export const disputeHoldCopy = (heldMinor: bigint) =>
  `A payment to you is being questioned. We've held ${naira(heldMinor)} until it's settled.`;

const FINAL: ReadonlySet<DisputeStatus> = new Set(['won', 'lost', 'closed']);

const outcomeOf = (status: DisputeStatus): DisputeOutcome =>
  status === 'won' ? 'won' : status === 'lost' ? 'lost' : 'updated';

/**
 * One partner event about a dispute on a collect tip. Matched to the tip as every platform event is
 * (R2); stored once (the partner's event id); folded into the dispute row; then advanced. A repeat
 * delivery is `duplicate`; an older event that changes nothing is `stale`.
 */
export function applyDisputeEvent(
  db: Database,
  i: { event: CollectDisputeEvent; provider: string; now: Date },
): Promise<{ outcome: DisputeOutcome }> {
  return guarded(async () => {
    const { event, now } = i;
    const attemptId = await matchCollectAttempt(db, {
      providerReference: event.providerReference,
      operationReference: event.operationReference,
      chargeReference: event.chargeReference,
    });
    if (!attemptId) return { outcome: 'unmatched' };
    const [tip] = await db
      .select({ id: tips.id, profileId: tips.profileId })
      .from(paymentAttempts)
      .innerJoin(tips, eq(tips.intentId, paymentAttempts.intentId))
      .where(eq(paymentAttempts.id, attemptId));
    const folded = await db.transaction(async (tx) => {
      const payload = jsonSafe(event);
      const stored = await tx
        .insert(providerEvents)
        .values({
          id: newId(),
          provider: i.provider,
          providerEventId: event.eventId,
          eventType: event.eventType,
          signatureVerified: true,
          payloadHash: createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex'),
          payload,
          attemptId,
          processedAt: now,
        })
        .onConflictDoNothing({
          target: [providerEvents.provider, providerEvents.providerEventId],
        })
        .returning({ id: providerEvents.id });
      if (!stored[0]) return { outcome: 'duplicate' as const, disputeId: null };
      if (!tip) {
        // A collect payment with no tip should not exist: the event is kept, and a person looks.
        await openIssue(tx, {
          dedupeKey: `dispute_no_tip.${event.partnerDisputeId}`,
          kind: 'dispute_opened',
          subject: { attemptId },
          note: `Dispute ${event.partnerDisputeId} names collect payment ${attemptId}, which has no tip. Nothing was held or booked.`,
          now,
        });
        return { outcome: 'unmatched' as const, disputeId: null };
      }
      const disputeId = newId();
      const inserted = await tx
        .insert(disputes)
        .values({
          id: disputeId,
          provider: i.provider,
          partnerDisputeId: event.partnerDisputeId,
          tipId: tip.id,
          amountMinor: event.amountMinor,
          currency: event.currency,
          reason: event.reason,
          status: event.status,
          respondBy: event.respondBy,
          decidedAt: FINAL.has(event.status) ? now : null,
          lastEventAt: event.occurredAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: disputes.partnerDisputeId })
        .returning({ id: disputes.id });
      const [row] = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.partnerDisputeId, event.partnerDisputeId))
        .for('update');
      if (!row) throw new Error('dispute vanished');
      // One partner dispute is about one charge: an event naming another tip changes nothing.
      if (row.tipId !== tip.id)
        return { outcome: 'stale' as const, disputeId: null };
      let outcome: DisputeOutcome;
      if (inserted[0]) {
        outcome = event.status === 'open' ? 'opened' : outcomeOf(event.status);
        await openIssue(tx, {
          dedupeKey: `dispute_opened.${row.id}`,
          kind: 'dispute_opened',
          subject: { tipId: tip.id, attemptId },
          note: `Dispute ${event.partnerDisputeId}: ${naira(event.amountMinor)} ${event.currency}${event.reason ? `, reason ${event.reason}` : ''}. ${event.respondBy ? `Respond by ${event.respondBy.toISOString()}.` : 'The partner gives no response deadline.'}`,
          now,
        });
      } else {
        const status = disputeStatusAfter(
          row.status as DisputeStatus,
          event.status,
        );
        const newer = event.occurredAt > row.lastEventAt;
        outcome =
          status !== row.status
            ? outcomeOf(status)
            : newer
              ? 'updated'
              : 'stale';
        if (outcome !== 'stale')
          await tx
            .update(disputes)
            .set({
              status,
              ...(FINAL.has(status) && !row.decidedAt
                ? { decidedAt: now }
                : {}),
              ...(newer
                ? {
                    lastEventAt: event.occurredAt,
                    ...(event.respondBy ? { respondBy: event.respondBy } : {}),
                    ...(event.reason ? { reason: event.reason } : {}),
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(disputes.id, row.id));
      }
      await bookFee(tx, row, event, now);
      await tx
        .update(providerEvents)
        .set({ processingOutcome: `dispute_${outcome}` })
        .where(eq(providerEvents.id, stored[0].id));
      return { outcome, disputeId: row.id };
    });
    // Best effort now; the transfer sweep finishes whatever is left (runDisputeSteps).
    if (folded.disputeId) await advanceDispute(db, folded.disputeId, now);
    return { outcome: folded.outcome };
  });
}

/**
 * The partner's dispute fee, TipMe's own cost (R6): booked once, in the currency reported, and kept
 * whatever the ruling. With none reported, staff are asked to post it by hand (one issue).
 */
async function bookFee(
  tx: Tx,
  row: DisputeRow,
  event: CollectDisputeEvent,
  now: Date,
): Promise<void> {
  const reported =
    event.feeMinor !== null &&
    event.feeMinor > 0n &&
    event.feeCurrency !== null &&
    /^[A-Z]{3}$/.test(event.feeCurrency);
  if (reported && row.feeMinor === null) {
    await tx
      .update(disputes)
      .set({
        feeMinor: event.feeMinor,
        feeCurrency: event.feeCurrency,
        updatedAt: now,
      })
      .where(eq(disputes.id, row.id));
    await postLedgerTransaction(tx, {
      operationType: 'dispute_fee',
      operationKey: `dispute_fee.${row.id}`,
      currency: event.feeCurrency!,
      tipId: row.tipId,
      traceId: null,
      lines: buildDisputeFeePosting({ feeMinor: event.feeMinor! }),
    });
    return;
  }
  if (row.feeMinor === null && !reported)
    await openIssue(tx, {
      dedupeKey: `dispute_fee_unposted.${row.id}`,
      kind: 'dispute_fee_unposted',
      subject: { tipId: row.tipId },
      note: `Dispute ${row.partnerDisputeId}: the partner reported no fee. Check the fee it took from TipMe's balance and in which currency.`,
      now,
    });
}

/** Locks the dispute row for one step. */
async function lockDispute(tx: Tx, disputeId: string): Promise<DisputeRow> {
  const [row] = await tx
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .for('update');
  if (!row) throw new OperationError('INVALID_INPUT');
  return row;
}

/** What the recipient can still give back now, under their profile's lock (as a withdrawal). */
async function recipientAvailable(tx: Tx, profileId: string): Promise<bigint> {
  await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for('update');
  const { availableMinor } = await balanceIn(tx, profileId);
  return availableMinor > 0n ? availableMinor : 0n;
}

/**
 * How much of a moved share can be held or taken back: this tip's share at most, never more than is
 * disputed, and never more than is still in the balance. The same cap on open and on loss, so a
 * dispute never reaches the recipient's later tips.
 */
async function fromMovedShare(
  tx: Tx,
  row: DisputeRow,
  share: CollectTransferRow,
): Promise<bigint> {
  return min(
    min(share.amountMinor, row.amountMinor),
    await recipientAvailable(tx, share.profileId),
  );
}

/**
 * Holds the share for a dispute (or, closed, for the refund): proven unmoved → review; moved → that
 * much of the balance; gone → nothing. Null while the share is in flight: nothing is held under a
 * transfer that may land; the read-back decides first. The recipient is told only while the
 * dispute is open (never after it closed).
 */
async function holdShare(
  tx: Tx,
  row: DisputeRow,
  position: SharePosition,
  reason: 'dispute' | 'refund',
  now: Date,
): Promise<'held' | 'balance' | 'none' | null> {
  if (position.state === 'in_flight') return null;
  if (position.state === 'gone') return 'none';
  if (position.state === 'held') {
    const took = await takeUnsentShare(tx, {
      transferId: position.row.id,
      to: 'review',
      reviewReason: reason,
      now,
    });
    return took ? 'held' : null;
  }
  const share = position.row;
  const held = await fromMovedShare(tx, row, share);
  await tx
    .update(disputes)
    .set({ heldMinor: held, updatedAt: now })
    .where(eq(disputes.id, row.id));
  if (held > 0n && reason === 'dispute')
    await tellRecipient(tx, row, share.profileId, held, now);
  return 'balance';
}

/** The dispute-hold notice (§10): in the app at once, and by email through the outbox. */
async function tellRecipient(
  tx: Tx,
  row: DisputeRow,
  profileId: string,
  heldMinor: bigint,
  now: Date,
): Promise<void> {
  const [owner] = await tx
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (owner?.userId)
    await tx
      .insert(notifications)
      .values({
        id: newId(),
        userId: owner.userId,
        kind: 'dispute_hold',
        tipId: row.tipId,
        title: 'A payment is being questioned',
        body: disputeHoldCopy(heldMinor),
        createdAt: now,
      })
      .onConflictDoNothing();
  await enqueueOutbox(tx, {
    eventType: DISPUTE_HOLD_EVENT,
    aggregateId: row.id,
    payload: { disputeId: row.id, profileId, heldMinor: heldMinor.toString() },
  });
}

/**
 * Moves a dispute on as far as it can go now (see the header). Idempotent; a step that has to wait
 * (a transfer in flight, a transfer back not paid yet, a closed dispute's hold kept for a refund) is
 * left for the sweep.
 */
export function advanceDispute(
  db: Database,
  disputeId: string,
  now: Date,
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockDispute(tx, disputeId);
      if (row.settledAt) return;
      const position = await sharePosition(tx, row.tipId);
      const status = row.status as DisputeStatus;
      if (status === 'open' || status === 'responded') {
        if (row.shareStep !== null) return;
        const step = await holdShare(tx, row, position, 'dispute', now);
        if (step)
          await tx
            .update(disputes)
            .set({ shareStep: step, updatedAt: now })
            .where(eq(disputes.id, row.id));
        return;
      }
      if (status === 'won') {
        if (row.shareStep === 'held' && position.row)
          await releaseHeldShare(tx, {
            transferId: position.row.id,
            reason: 'dispute',
            now,
          });
        await tx
          .update(disputes)
          .set({ heldMinor: 0n, settledAt: now, updatedAt: now })
          .where(eq(disputes.id, row.id));
        return;
      }
      if (status === 'closed') {
        await closeWithoutRuling(tx, row, position, now);
        return;
      }
      await settleLost(tx, row, position, now);
    }),
  );
}

/**
 * Whether a refund of the tip has been asked for, booked, or reported by the partner: then a closed
 * dispute's hold stays for it (P28, Task 10).
 */
async function refundSeen(tx: Tx, tipId: string): Promise<boolean> {
  const result = await tx.execute<{ seen: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM tip_refunds r WHERE r.tip_id = ${tipId} AND r.status <> 'FAILED')
        OR EXISTS (SELECT 1 FROM ledger_transactions t
                    WHERE t.tip_id = ${tipId} AND t.operation_type = 'reversal')
        OR EXISTS (
          SELECT 1 FROM unmatched_provider_events u
            JOIN payment_attempts pa ON TRUE
            JOIN tips tp ON tp.intent_id = pa.intent_id AND tp.id = ${tipId}
           WHERE u.reason = 'collect_event' AND u.event_type LIKE '%refund%'
             AND (u.payload->>'operationReference' = pa.id::text
                  OR u.payload->>'providerReference' = pa.provider_reference
                  OR u.payload->>'chargeReference' IN (
                       SELECT c.charge_reference FROM collect_transfers c
                        WHERE c.tip_id = ${tipId} AND c.charge_reference IS NOT NULL)))
      AS seen`);
  return result.rows[0]?.seen === true;
}

/**
 * Closed without a ruling. The supporter may have been refunded (the partner's `prevented`), and
 * the refund event books that money: releasing the share to the recipient as well would pay it
 * twice. So nothing is booked, the hold is kept for the refund (P28) and staff are told; the
 * recipient is not told anything new. With no refund for the tip after CLOSED_HOLD_KEPT_MS, the hold
 * is released and the dispute settled.
 */
async function closeWithoutRuling(
  tx: Tx,
  row: DisputeRow,
  position: SharePosition,
  now: Date,
): Promise<void> {
  let step = row.shareStep;
  if (step === 'held' && position.row)
    await releaseHeldShare(tx, {
      transferId: position.row.id,
      reason: 'dispute',
      as: 'refund',
      now,
    });
  if (step === null) {
    step = await holdShare(tx, row, position, 'refund', now);
    if (step === null) return; // In flight: wait for the read-back.
    await tx
      .update(disputes)
      .set({ shareStep: step, updatedAt: now })
      .where(eq(disputes.id, row.id));
  }
  await openIssue(tx, {
    dedupeKey: `dispute_closed.${row.id}`,
    kind: 'collect_transfer_review',
    subject: { tipId: row.tipId },
    note: `Dispute ${row.partnerDisputeId} closed without a ruling. Nothing was booked as lost. The share stays held for a refund for ${CLOSED_HOLD_KEPT_MS / 86_400_000} days; with none, it is released.`,
    now,
  });
  const since = (row.decidedAt ?? now).getTime();
  if (now.getTime() - since < CLOSED_HOLD_KEPT_MS) return;
  if (await refundSeen(tx, row.tipId)) return;
  if (step === 'held' && position.row)
    await releaseHeldShare(tx, {
      transferId: position.row.id,
      reason: 'refund',
      now,
    });
  await tx
    .update(disputes)
    .set({ heldMinor: 0n, settledAt: now, updatedAt: now })
    .where(eq(disputes.id, row.id));
}

/** A lost dispute waiting on money in flight: after a day, staff hear of it (once). */
async function waiting(
  tx: Tx,
  row: DisputeRow,
  now: Date,
  what: string,
): Promise<'waiting_back'> {
  const since = (row.decidedAt ?? row.lastEventAt).getTime();
  if (now.getTime() - since > LOST_WAITING_ALERT_MS)
    await openIssue(tx, {
      dedupeKey: `dispute_waiting.${row.id}`,
      kind: 'collect_transfer_stuck',
      subject: { tipId: row.tipId },
      note: `Dispute ${row.partnerDisputeId} was lost over a day ago and is still waiting: ${what}. Nothing has been booked as lost yet.`,
      now,
    });
  return 'waiting_back';
}

type ShareSweepRow = typeof shareTransfers.$inferSelect;

/**
 * Lost: recovery from the recipient's unpaid balance first, then the business's share held for it,
 * then TipMe absorbs the rest (§6.2, R3). Nothing is changed unless the loss can be booked in the
 * payment's currency.
 */
async function settleLost(
  tx: Tx,
  row: DisputeRow,
  position: SharePosition,
  now: Date,
): Promise<'posted' | 'waiting_back'> {
  if (position.state === 'in_flight')
    return waiting(
      tx,
      row,
      now,
      "the share's transfer is still being read back",
    );
  const [businessSweep] = (await tx
    .select()
    .from(shareTransfers)
    .where(
      and(
        eq(shareTransfers.tipId, row.tipId),
        eq(shareTransfers.kind, 'collect_sweep'),
      ),
    )
    .for('update')) as ShareSweepRow[];
  if (businessSweep?.status === 'in_sent')
    return waiting(tx, row, now, "the business share's transfer is in flight");
  // The payment it reverses, and its currency, before anything is touched: a dispute TipMe can't
  // book changes nothing, however often it is swept.
  const [payment] = await tx
    .select({
      id: ledgerTransactions.id,
      currency: ledgerTransactions.currency,
    })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.tipId, row.tipId),
        eq(ledgerTransactions.operationType, 'payment'),
      ),
    );
  if (!payment) throw new Error('a collect tip has its payment posting');
  if (payment.currency !== row.currency) {
    await openIssue(tx, {
      dedupeKey: `dispute_currency.${row.id}`,
      kind: 'collect_recon_mismatch',
      subject: { tipId: row.tipId },
      note: `Dispute ${row.partnerDisputeId} is in ${row.currency}, the tip in ${payment.currency}. Nothing was held back, cancelled or booked.`,
      now,
    });
    return 'waiting_back';
  }
  const share = position.row;
  let recovered = 0n;
  if (position.state === 'held') {
    const { row: held } = position;
    const recovery = disputeRecovery({
      disputedMinor: row.amountMinor,
      netMinor: held.amountMinor,
      share: { state: 'held', heldMinor: held.amountMinor },
    });
    if ('wait' in recovery) return 'waiting_back';
    recovered = recovery.fromHeldMinor;
    const took =
      recovered === held.amountMinor
        ? await takeUnsentShare(tx, {
            transferId: held.id,
            to: 'cancelled',
            reviewReason: 'dispute',
            now,
          })
        : // A partial dispute: the share keeps the rest (released if it was held for this dispute,
          // else still held for its own reason).
          await reduceUnsentShare(tx, {
            transferId: held.id,
            byMinor: recovered,
            now,
          });
    if (!took) {
      await openIssue(tx, {
        dedupeKey: `dispute_share.${row.id}`,
        kind: 'collect_transfer_review',
        subject: { tipId: row.tipId },
        note: `Dispute ${row.partnerDisputeId} was lost, but its share ${held.id} could not be taken back automatically. Nothing was booked.`,
        now,
      });
      return 'waiting_back';
    }
  } else if (position.state === 'moved') {
    const moved = position.row;
    const [back] = await tx
      .select()
      .from(collectTransfers)
      .where(
        and(
          eq(collectTransfers.disputeId, row.id),
          eq(collectTransfers.kind, 'back'),
        ),
      );
    if (back) {
      if (back.status !== 'paid') return 'waiting_back';
      recovered = back.amountMinor;
    } else {
      // The same cap as on open: this tip's share, at most what is still in the balance.
      const inBalance =
        row.shareStep === 'balance'
          ? row.heldMinor
          : await fromMovedShare(tx, row, moved);
      const recovery = disputeRecovery({
        disputedMinor: row.amountMinor,
        netMinor: moved.amountMinor,
        share: { state: 'moved', inBalanceMinor: inBalance },
      });
      if ('wait' in recovery) return 'waiting_back';
      if (recovery.backMinor > 0n && moved.accountReference) {
        // The same machine sends it (collectToPlatform, as the recipient's account). Held from
        // their balance until it is paid.
        await tx.insert(collectTransfers).values({
          id: newId(),
          kind: 'back',
          tipId: row.tipId,
          profileId: moved.profileId,
          disputeId: row.id,
          accountReference: moved.accountReference,
          provider: moved.provider,
          environment: moved.environment,
          amountMinor: recovery.backMinor,
          currency: moved.currency,
          status: 'ready',
          idempotencyKey: `tipme-collect-back-${row.id}`,
          nextTryAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await tx
          .update(disputes)
          .set({
            heldMinor: recovery.backMinor,
            shareStep: row.shareStep ?? 'balance',
            updatedAt: now,
          })
          .where(eq(disputes.id, row.id));
        return 'waiting_back';
      }
    }
  }
  const profileId =
    share?.profileId ??
    (
      await tx
        .select({ profileId: tips.profileId })
        .from(tips)
        .where(eq(tips.id, row.tipId))
    )[0]?.profileId;
  const parts: ({ amountMinor: bigint } & (
    { profileId: string } | { businessId: string }
  ))[] =
    recovered > 0n && profileId ? [{ amountMinor: recovered, profileId }] : [];
  // R3: the business's share of the tip, while TipMe still holds it (its leg in never sent, or
  // refused), comes back next, up to what is still disputed.
  if (businessSweep?.businessId) {
    const left = row.amountMinor - recovered;
    const owed = businessSweep.deliverMinor ?? businessSweep.amountMinor;
    if (
      (businessSweep.status === 'out_paid' ||
        businessSweep.status === 'review') &&
      left > 0n &&
      owed > 0n
    ) {
      const take = min(owed, left);
      const [taken] = await tx
        .update(shareTransfers)
        .set(
          take === owed
            ? { status: 'cancelled', updatedAt: now }
            : {
                amountMinor: sql`${shareTransfers.amountMinor} - ${take}`,
                deliverMinor: owed - take,
                updatedAt: now,
              },
        )
        .where(
          and(
            eq(shareTransfers.id, businessSweep.id),
            inArray(shareTransfers.status, ['out_paid', 'review']),
          ),
        )
        .returning({ id: shareTransfers.id });
      if (taken)
        parts.push({ amountMinor: take, businessId: businessSweep.businessId });
    } else if (businessSweep.status === 'done')
      // Already in the business's own account: TipMe absorbs it, and a person decides whether to
      // ask the business for it (option B's reverseTip path), with the amount on record.
      await openIssue(tx, {
        dedupeKey: `dispute_business.${row.id}`,
        kind: 'collect_transfer_review',
        subject: { tipId: row.tipId },
        note: `Dispute ${row.partnerDisputeId} was lost after the business's share (${naira(owed)}) had moved to its account. TipMe absorbed it; recover it from the business by hand if that is decided.`,
        now,
      });
  }
  await postLedgerTransaction(tx, {
    operationType: 'reversal',
    operationKey: `dispute_loss.${row.id}`,
    currency: row.currency,
    tipId: row.tipId,
    reversesTransactionId: payment.id,
    traceId: null,
    lines: buildDisputeLossPosting({
      disputedMinor: row.amountMinor,
      recovered: parts,
    }),
  });
  await tx
    .update(disputes)
    .set({
      heldMinor: 0n,
      settledAt: now,
      shareStep: row.shareStep ?? (position.state === 'held' ? 'held' : 'none'),
      updatedAt: now,
    })
    .where(eq(disputes.id, row.id));
  return 'posted';
}

/**
 * Books a lost dispute once its recovery is done: `posted` now, `waiting_back` while a transfer is
 * in flight or the transfer back is not paid yet, `done` when it was already booked.
 */
export function settleLostDispute(
  db: Database,
  i: { disputeId: string; now: Date },
): Promise<'posted' | 'waiting_back' | 'done'> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockDispute(tx, i.disputeId);
      if (row.settledAt) return 'done' as const;
      if (row.status !== 'lost') throw new OperationError('INVALID_INPUT');
      return settleLost(tx, row, await sharePosition(tx, row.tipId), i.now);
    }),
  );
}

/**
 * The dispute part of the transfer sweep (every 2 minutes): a reminder 48 hours before evidence is
 * due, and every unsettled dispute advanced (a read-back settled its share, a transfer back paid).
 */
export function runDisputeSteps(
  db: Database,
  i: { now: Date; limit?: number },
): Promise<{ reminded: number; advanced: number; failed: number }> {
  return guarded(async () => {
    const { now } = i;
    const limit = i.limit ?? SWEEP_LIMIT;
    const due = await db
      .select({
        id: disputes.id,
        tipId: disputes.tipId,
        partnerDisputeId: disputes.partnerDisputeId,
        respondBy: disputes.respondBy,
      })
      .from(disputes)
      .where(
        and(
          eq(disputes.status, 'open'),
          lte(disputes.respondBy, new Date(now.getTime() + DEADLINE_NOTICE_MS)),
          // Once each: a reminder already opened is not looked at again.
          sql`NOT EXISTS (SELECT 1 FROM issues i WHERE i.dedupe_key = 'dispute_deadline.' || ${disputes.id}::text)`,
        ),
      )
      .orderBy(asc(disputes.respondBy))
      .limit(limit);
    let reminded = 0;
    for (const dispute of due) {
      const { opened } = await openIssue(db, {
        dedupeKey: `dispute_deadline.${dispute.id}`,
        kind: 'dispute_deadline',
        subject: { tipId: dispute.tipId },
        note: `Dispute ${dispute.partnerDisputeId}: evidence is due by ${dispute.respondBy?.toISOString()}.`,
        now,
      });
      if (opened) reminded += 1;
    }
    const open = await db
      .select({ id: disputes.id })
      .from(disputes)
      .where(isNull(disputes.settledAt))
      .orderBy(asc(disputes.createdAt), asc(disputes.id))
      .limit(limit);
    let advanced = 0;
    let failed = 0;
    for (const { id } of open) {
      try {
        await advanceDispute(db, id, now);
        advanced += 1;
      } catch {
        // One dispute's trouble never stops the others; it is tried again next sweep.
        failed += 1;
      }
    }
    return { reminded, advanced, failed };
  });
}
