import {
  buildAbsorbedRefundPosting,
  buildCollectRefundPosting,
  canTransition,
  collectRefundPlan,
  TIP_REFUND_TRANSITIONS,
  tipRefundParts,
  type LedgerLine,
  type Owner,
  type TipRefundStatus,
} from '@tipme/domain';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  collectTransfers,
  disputes,
  ledgerTransactions,
  paymentIntents,
  profiles,
  shareTransfers,
  tipQuotes,
  tipRefunds,
  tips,
} from '../schema.js';
import { balanceIn } from './balance.js';
import {
  KEY_TRUSTED_FOR_MS,
  releaseHeldShare,
  sharePosition,
  takeUnsentShare,
  type SharePosition,
} from './collect-transfers.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { openIssue } from './issues.js';
import { postLedgerTransaction } from './ledger.js';
import { reverseTip } from './reversals.js';
import { scheduleCollectRecover } from './share-transfers.js';
import { recordTransition } from './transitions.js';

/*
 * Staff "Refund tip" (owner, 14 Nov 2026), behind the `tip_refunds` switch (off by default). TipMe keeps its fee:
 * the supporter gets back the tip minus TipMe's fee on that tip's quote, which is exactly what its
 * recipients received. Staff ask and a second person approves (`tip.refund`, a serious action);
 * approving only records the refund (REQUESTED). The worker asks our payment partner once, as the
 * recipient's account, with the key `tipme-tip-refund-<id>` (the same key returns the same refund),
 * and only refund.paid books it: `reverseTip` under the refund rule, so the person and the business
 * each give back what they received and nothing of TipMe's fee moves. A refusal or refund.failed
 * moves nothing and tells staff; a failed refund doesn't count, so it can be asked again. Tips paid
 * by bank transfer can't be refunded by the partner (its refund guide).
 *
 * You collect (plan Task 10, spec §6.1, P7, P26–P30, P28): a tip quoted `collect` was charged to
 * TipMe's own account, so its refund comes out of TipMe's balance (`refundPlatformCharge`), for the
 * same amount, and TipMe recovers the recipient's part first:
 *
 *   cancel_held  the share never moved: held for the refund when it is asked for (review, reason
 *                `refund`), cancelled only when refund.paid books it, let go if the refund fails.
 *   take_back    it moved and is still in their balance: a `back` transfer (the collect machine,
 *                key `tipme-collect-back-<refundId>`) takes it back first; the refund is sent only
 *                once that is paid.
 *   absorb       some of it can't be taken back (they withdrew it, or a business's share already
 *                swept may not be there): staff decide, and going ahead is a second person's serious
 *                action (`tip_refund.absorb_gap`). What can be taken back is; TipMe absorbs the rest
 *                (`refund_loss_expense`, R6), never more than the gap they approved.
 *
 * A business's share is taken from what TipMe holds for it, or pulled back from the business's
 * account once swept (Task 9's `collect_recover`). Nothing is held or cancelled under a transfer in
 * flight (`in_flight`: the read-back decides first, P26). Before anything moves the worker reads how
 * the tip was paid (a bank transfer can't be refunded) and TipMe's balance (one too low to refund
 * fails it, nothing moved). The booking (`collect_refund.<refundId>`, a reversal of the payment)
 * also consumes a closed dispute's hold kept for this refund (P28).
 */

/** The partner answers the same key with the same refund; after 24 hours TipMe never resends. */
const RESEND_WITHIN_MS = 24 * 3_600_000;
const RESEND_AFTER_MS = 2 * 60_000;

export type TipRefundRefusal =
  | 'not_paid'
  | 'team'
  | 'already'
  | 'bank_transfer'
  | 'no_charge'
  | 'in_flight'
  | 'disputed'
  | 'paid_unbooked';

/** What staff read, in plain words (the partner is never named). */
const REFUSAL_WORDS: Record<TipRefundRefusal, string> = {
  not_paid: 'This tip isn’t paid, so there is nothing to refund.',
  team: 'A tip shared by a whole team can’t be refunded from here yet.',
  already:
    'This tip already has a refund in progress or paid, or it was already taken back (a refund or chargeback).',
  bank_transfer:
    'This tip was paid by bank transfer, so it can’t be refunded through our payment partner.',
  no_charge:
    'TipMe doesn’t know which payment this was with our payment partner, so it can’t be refunded from here.',
  in_flight:
    "This tip's share is moving to the recipient right now. Try again in a few minutes.",
  disputed:
    'This tip has an open dispute. It can’t be refunded from here until the dispute is settled.',
  paid_unbooked:
    'Our payment partner refunded this tip, but TipMe didn’t expect it and hasn’t recorded it. Settle the money issue first: it can’t be refunded or returned again from here.',
};

/** Why the last refund of a tip failed, for staff (nothing moved unless the issue says so). */
const FAILURE_WORDS: Record<string, string> = {
  bank_transfer: REFUSAL_WORDS.bank_transfer,
  balance: "TipMe's balance can't cover this refund right now.",
  not_recovered:
    'The recipient’s part couldn’t be taken back, so nothing was refunded.',
  not_refundable: 'Our payment partner said this payment can’t be refunded.',
  disputed:
    'A dispute opened on this tip before the refund was sent, so it wasn’t sent.',
  refused: 'Our payment partner refused the refund.',
  partner_failed: 'Our payment partner reported the refund failed.',
};

/** How a collect tip's refund recovers the recipient's part (spec §6.1; see the header). */
export type CollectRefundPlanKind =
  'cancel_held' | 'take_back' | 'staff_decides' | 'wait';

export interface TipRefundFacts {
  refundable: boolean;
  refusal: TipRefundRefusal | null;
  words: string;
  tipId: string;
  handle: string | null;
  profileId: string | null;
  grossMinor: bigint;
  /** TipMe's fee on the tip's quote: kept. */
  feeMinor: bigint;
  /** What the supporter gets back: the tip minus TipMe's fee. */
  refundMinor: bigint;
  personMinor: bigint;
  businessMinor: bigint;
  businessName: string | null;
  provider: string | null;
  providerReference: string | null;
  refund: { id: string; status: TipRefundStatus } | null;
  /**
   * You collect (Task 10): how the recipient's part comes back first, and what TipMe would absorb
   * (`staff_decides`: at most `gapMinor`). Null for a direct tip.
   */
  collect: { plan: CollectRefundPlanKind; gapMinor: bigint } | null;
  /** Why the latest refund of this tip failed, when it did and none is open now. */
  lastFailure: string | null;
  /**
   * You collect (RI1): what this tip's refunds already took back from the recipient, held by TipMe
   * for its refund (a new ask uses it; staff may return it instead). Zero for a direct tip.
   */
  heldMinor: bigint;
  /** RI3: what the partner refunded that TipMe didn't book (an unexpected refund.paid). */
  unbookedMinor: bigint;
}

/**
 * Whether a tip can be refunded now, what the supporter gets back and who gives back what. Read
 * under the tip's lock to act on. `method` is the partner's own answer, when the caller read it.
 */
export async function tipRefundFacts(
  db: Database | Tx,
  tipId: string,
  read: { method?: 'card' | 'bank_transfer' | 'other' } = {},
): Promise<TipRefundFacts> {
  const result = await db.execute<{
    tip_id: string;
    status: string;
    profile_id: string | null;
    handle: string | null;
    gross: string;
    net: string;
    share: string | null;
    business_name: string | null;
    provider: string | null;
    provider_reference: string | null;
    reversed: boolean;
  }>(sql`
    SELECT t.id AS tip_id, t.status, t.profile_id, p.handle,
           q.tip_minor::text AS gross, q.recipient_net_minor::text AS net,
           s.share_minor::text AS share, b.name AS business_name,
           a.provider, a.provider_reference,
           EXISTS (SELECT 1 FROM ledger_transactions x
                    WHERE x.tip_id = t.id AND x.operation_type = 'reversal') AS reversed
      FROM tips t
      JOIN payment_intents i ON i.id = t.intent_id
      JOIN tip_quotes q ON q.id = i.quote_id
      LEFT JOIN profiles p ON p.id = t.profile_id
      LEFT JOIN tip_business_shares s ON s.tip_id = t.id
      LEFT JOIN businesses b ON b.id = s.business_id
      LEFT JOIN LATERAL (
        SELECT provider, provider_reference FROM payment_attempts
         WHERE intent_id = t.intent_id AND status = 'VERIFIED_SUCCEEDED'
         ORDER BY created_at DESC LIMIT 1
      ) a ON true
     WHERE t.id = ${tipId}`);
  const row = result.rows[0];
  if (!row) throw new OperationError('TIP_REFUND_REFUSED', 'not_paid');
  const rows = await db
    .select({
      id: tipRefunds.id,
      status: tipRefunds.status,
      failure: tipRefunds.failure,
      refundedMinor: tipRefunds.refundedMinor,
    })
    .from(tipRefunds)
    .where(eq(tipRefunds.tipId, tipId))
    .orderBy(desc(tipRefunds.createdAt));
  const open = rows.find((r) => r.status !== 'FAILED') ?? null;
  // RI3: a refund the partner paid that TipMe didn't book (an unexpected refund.paid).
  const unbooked =
    rows.find((r) => r.status !== 'PAID' && r.refundedMinor !== null) ?? null;
  const bankTransfer =
    read.method === 'bank_transfer' ||
    rows.some((r) => r.failure === 'bank_transfer');
  const grossMinor = BigInt(row.gross);
  const netMinor = BigInt(row.net);
  const parts =
    netMinor > 0n
      ? tipRefundParts({
          recipientNetMinor: netMinor,
          businessShareMinor: row.share ? BigInt(row.share) : 0n,
        })
      : { refundMinor: 0n, personMinor: 0n, businessMinor: 0n };
  // A collect tip (the mode it was quoted under, never the page's now): how its part comes back.
  const collect =
    (await quotedMode(db, row.tip_id)) === 'collect' &&
    row.status === 'SUCCEEDED' &&
    row.profile_id &&
    netMinor > 0n
      ? await readCollect(db, row.tip_id, row.profile_id, parts)
      : null;
  const refusal: TipRefundRefusal | null =
    row.status !== 'SUCCEEDED'
      ? 'not_paid'
      : !row.profile_id
        ? 'team'
        : unbooked
          ? 'paid_unbooked'
          : open || row.reversed || collect?.refusal === 'already'
            ? 'already'
            : collect?.refusal === 'disputed'
              ? 'disputed'
              : bankTransfer
                ? 'bank_transfer'
                : !row.provider ||
                    !row.provider_reference ||
                    netMinor <= 0n ||
                    (collect !== null && !collect.chargeReference)
                  ? 'no_charge'
                  : collect?.plan === 'wait'
                    ? 'in_flight'
                    : null;
  const latest = rows[0];
  return {
    refundable: refusal === null,
    refusal,
    words: refusal
      ? REFUSAL_WORDS[refusal]
      : 'This tip can be refunded. TipMe keeps its fee.',
    tipId: row.tip_id,
    handle: row.handle,
    profileId: row.profile_id,
    grossMinor,
    feeMinor: grossMinor - netMinor,
    ...parts,
    businessName: row.business_name,
    provider: row.provider,
    providerReference: row.provider_reference,
    refund: open
      ? { id: open.id, status: open.status as TipRefundStatus }
      : null,
    collect: collect
      ? { plan: collect.plan, gapMinor: collect.gapMinor }
      : null,
    heldMinor: collect?.heldForTipMinor ?? 0n,
    unbookedMinor: unbooked?.refundedMinor ?? 0n,
    lastFailure:
      !open && latest?.status === 'FAILED'
        ? (FAILURE_WORDS[latest.failure ?? ''] ?? FAILURE_WORDS['refused']!)
        : null,
  };
}

/**
 * RC2: a refund of the tip was paid and a dispute on it lost: the supporter got the money back twice.
 * One money issue per tip, from whichever is booked second, naming both amounts.
 */
export async function tellRefundAndDispute(
  tx: Tx,
  input: {
    tipId: string;
    refundMinor: bigint;
    disputeMinor: bigint;
    now: Date;
  },
): Promise<void> {
  await openIssue(tx, {
    dedupeKey: `tip_refund_and_dispute.${input.tipId}`,
    kind: 'collect_recon_mismatch',
    subject: { tipId: input.tipId },
    note: `The supporter got this tip's money back twice: a refund of ${naira(input.refundMinor)} was paid and a dispute of ${naira(input.disputeMinor)} was lost. Both are booked as they happened. Ask our payment partner (Bachs) to reverse one, or record the loss.`,
    now: input.now,
  });
}

/** Whether the tip's money already went back (a refund or dispute booked as a reversal). */
async function tipReversed(db: Database | Tx, tipId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.tipId, tipId),
        eq(ledgerTransactions.operationType, 'reversal'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The mode the tip was quoted under (never the page's mode now: a tip keeps its quote's). */
async function quotedMode(
  db: Database | Tx,
  tipId: string,
): Promise<string | null> {
  const [quoted] = await db
    .select({ mode: tipQuotes.collectionMode })
    .from(tips)
    .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
    .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
    .where(eq(tips.id, tipId));
  return quoted?.mode ?? null;
}

/** What a collect tip's refund would do with the recipient's part, read now (see the header). */
interface CollectRead {
  plan: CollectRefundPlanKind;
  /** What TipMe would absorb at most (`staff_decides`). */
  gapMinor: bigint;
  refusal: 'already' | 'disputed' | null;
  share: SharePosition;
  /** The person's part taken back from their balance (a moved share). */
  backMinor: bigint;
  /** What the refund holds of their balance: their part, less what a closed dispute holds of it. */
  holdMinor: bigint;
  chargeReference: string | null;
  /** What this tip's refunds already took back from the recipient and TipMe holds (RI1). */
  heldForTipMinor: bigint;
}

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

type SweepRow = typeof shareTransfers.$inferSelect;

/**
 * Ruling (fix round 1, C1): what a tip's refunds have already taken back belongs to the tip's
 * refund, not to one attempt. A refund that fails after its recipient's part came back keeps that
 * money held by TipMe (and reserved from their balance); the next refund of the tip uses it and never
 * takes it again. Only one refund of a tip is ever open, and a paid one ends the tip's refunds
 * (`already`), so every paid transfer back and finished pull-back on the tip is unspent until then.
 */
export async function recoveredOnTip(
  db: Database | Tx,
  tipId: string,
): Promise<{
  personMinor: bigint;
  pullBack: SweepRow | null;
  /** A return of it to the recipient is under way (RI1): nothing else may use it meanwhile. */
  returning: boolean;
}> {
  const moves = await db
    .select({
      kind: collectTransfers.kind,
      status: collectTransfers.status,
      amountMinor: collectTransfers.amountMinor,
    })
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.tipId, tipId),
        inArray(collectTransfers.kind, ['back', 'return']),
        isNotNull(collectTransfers.refundId),
      ),
    );
  const backs = moves.filter((m) => m.kind === 'back' && m.status === 'paid');
  const returned = moves
    .filter((m) => m.kind === 'return' && m.status === 'paid')
    .reduce((sum, m) => sum + m.amountMinor, 0n);
  const returning = moves.some(
    (m) =>
      m.kind === 'return' && m.status !== 'paid' && m.status !== 'cancelled',
  );
  const [pullBack] = await db
    .select()
    .from(shareTransfers)
    .where(
      and(
        eq(shareTransfers.tipId, tipId),
        eq(shareTransfers.kind, 'collect_recover'),
        isNotNull(shareTransfers.tipRefundId),
      ),
    )
    .orderBy(desc(shareTransfers.createdAt))
    .limit(1);
  const taken = backs.reduce((sum, b) => sum + b.amountMinor, 0n);
  return {
    personMinor: taken > returned ? taken - returned : 0n,
    pullBack: pullBack ?? null,
    returning,
  };
}

/**
 * A dispute on the tip that wasn't won or closed: open, responded, or lost (settled or not). A
 * refund now would return the money twice (RC1).
 */
async function unsettledDispute(
  db: Database | Tx,
  tipId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.tipId, tipId),
        inArray(disputes.status, ['open', 'responded', 'lost']),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Reads where a collect tip's money is for a refund. The person's part: the share held (cancel),
 * moved and still in their balance (take back), or moved and partly gone (a gap). A closed dispute's
 * hold on that balance is for this refund (P28), so it counts as theirs to give back. The business's
 * part: held by TipMe (taken), or swept to the business (pulled back, but it may be gone: a gap).
 * Anything in flight waits; an unsettled dispute refuses.
 */
async function readCollect(
  db: Database | Tx,
  tipId: string,
  profileId: string,
  parts: { personMinor: bigint; businessMinor: bigint },
): Promise<CollectRead> {
  const onTip = await db
    .select({
      status: disputes.status,
      heldMinor: disputes.heldMinor,
      settledAt: disputes.settledAt,
    })
    .from(disputes)
    .where(eq(disputes.tipId, tipId));
  const share = await sharePosition(db, tipId);
  const recovered = await recoveredOnTip(db, tipId);
  const base = {
    gapMinor: 0n,
    share,
    backMinor: 0n,
    holdMinor: 0n,
    chargeReference: share.row?.chargeReference ?? null,
    // RM3: once the tip's money went back (a lost dispute used it), nothing is held any more.
    heldForTipMinor: (await tipReversed(db, tipId))
      ? 0n
      : recovered.personMinor,
  };
  if (
    onTip.some(
      (d) =>
        d.status === 'open' ||
        d.status === 'responded' ||
        (d.status === 'lost' && !d.settledAt),
    )
  )
    return { ...base, plan: 'wait', refusal: 'disputed' };
  // RI4: of that hold, what an earlier refund of the tip already took back is held by TipMe now
  // (counted once, in held_for_recipients): only the rest is still in their account.
  const closedHold = onTip
    .filter((d) => d.status === 'closed' && !d.settledAt)
    .reduce((sum, d) => sum + d.heldMinor, 0n);
  const keptForRefund =
    closedHold > recovered.personMinor
      ? closedHold - recovered.personMinor
      : 0n;
  let wait = false;
  let gap = 0n;
  let moved = false;
  let backMinor = 0n;
  let holdMinor = 0n;
  const person = parts.personMinor;
  if (recovered.returning) wait = true;
  if (person > 0n) {
    if (share.state === 'in_flight') wait = true;
    else if (share.state === 'gone')
      return { ...base, plan: 'wait', refusal: 'already' };
    // Held by TipMe already (held_for_recipients, Task 12): never part of what they can withdraw,
    // so nothing more to reserve.
    else if (share.state === 'held') holdMinor = 0n;
    else {
      moved = true;
      // What an earlier refund already took back is used, never taken again (C1).
      const left =
        person > recovered.personMinor ? person - recovered.personMinor : 0n;
      const { availableMinor } = await balanceIn(db, profileId);
      const inBalance = minOf(
        share.row.amountMinor - (person - left),
        (availableMinor > 0n ? availableMinor : 0n) + keptForRefund,
      );
      const plan =
        left === 0n
          ? ({ kind: 'take_back', backMinor: 0n } as const)
          : collectRefundPlan({
              refundMinor: left,
              share: { state: 'moved', inBalanceMinor: inBalance },
            });
      if (plan.kind === 'take_back') backMinor = plan.backMinor;
      else if (plan.kind === 'staff_decides') {
        gap += plan.gapMinor;
        backMinor = left - plan.gapMinor;
      }
      // The dispute's hold already keeps that much from them: held once, not twice.
      holdMinor = backMinor > keptForRefund ? backMinor - keptForRefund : 0n;
    }
  }
  if (parts.businessMinor > 0n) {
    const [sweep] = await db
      .select({
        status: shareTransfers.status,
        refusedAt: shareTransfers.refusedAt,
      })
      .from(shareTransfers)
      .where(
        and(
          eq(shareTransfers.tipId, tipId),
          eq(shareTransfers.kind, 'collect_sweep'),
        ),
      );
    const status = sweep?.status;
    const pullBack = recovered.pullBack;
    if (status === 'in_sent' || (status === 'review' && !sweep?.refusedAt))
      wait = true;
    else if (status === 'done') {
      // Swept to the business: pulled back first (M3). Only what a pull-back couldn't find is a gap.
      moved = true;
      if (pullBack?.status === 'done') {
        const got = minOf(pullBack.amountMinor, parts.businessMinor);
        gap += parts.businessMinor - got;
      } else if (pullBack?.status === 'gap') gap += parts.businessMinor;
      else if (pullBack) wait = true;
    } else if (status !== 'out_paid' && status !== 'review')
      return { ...base, plan: 'wait', refusal: 'already' };
  }
  return {
    ...base,
    refusal: null,
    plan: wait
      ? 'wait'
      : gap > 0n
        ? 'staff_decides'
        : moved
          ? 'take_back'
          : 'cancel_held',
    gapMinor: wait ? 0n : gap,
    backMinor,
    holdMinor,
  };
}

/**
 * The serious action's work (`tip.refund`, or `tip_refund.absorb_gap` with `absorbGap`): checks again
 * under the tip's lock and records the approved refund for the worker to send. Moves no money and
 * books nothing. A collect tip's share still held is held for the refund now (P7).
 */
export async function askTipRefund(
  tx: Tx,
  input: {
    tipId: string;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
    /** A second person decided TipMe absorbs what can't be taken back (collect tips only). */
    absorbGap?: boolean;
  },
): Promise<{ refundId: string; amountMinor: string }> {
  const [tip] = await tx
    .select({ id: tips.id, profileId: tips.profileId })
    .from(tips)
    .where(eq(tips.id, input.tipId))
    .for('update');
  if (!tip) throw new OperationError('TIP_REFUND_REFUSED', 'not_paid');
  // A collect tip's plan reads the recipient's balance: under their lock, as a withdrawal is.
  if (tip.profileId && (await quotedMode(tx, input.tipId)) === 'collect')
    await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, tip.profileId))
      .for('update');
  const facts = await tipRefundFacts(tx, input.tipId);
  if (!facts.refundable || !facts.provider || !facts.providerReference)
    throw new OperationError('TIP_REFUND_REFUSED', facts.refusal ?? 'not_paid');
  if (facts.collect) return askCollectRefund(tx, input, facts);
  if (input.absorbGap) throw new OperationError('TIP_REFUND_REFUSED', 'no_gap');
  const id = newId();
  await tx.insert(tipRefunds).values({
    id,
    tipId: input.tipId,
    status: 'REQUESTED',
    amountMinor: facts.refundMinor,
    currency: 'NGN',
    provider: facts.provider,
    providerReference: facts.providerReference,
    requestedBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await recordTransition(tx, {
    entityType: 'tip_refund',
    entityId: id,
    fromStatus: null,
    toStatus: 'REQUESTED',
    cause: 'staff',
    traceId: activeTraceId(),
  });
  return { refundId: id, amountMinor: String(facts.refundMinor) };
}

/**
 * Records a collect tip's refund (under the tip's and the recipient's locks). `staff_decides` needs
 * the second person's `tip_refund.absorb_gap`; then up to the gap read now is TipMe's. A share
 * still held is held for the refund (P27's guard: never one that may have moved). A moved share's
 * transfer back is recorded now, waiting, for the amount read under the lock: the worker releases
 * it once it has checked the tip can be refunded at all.
 */
async function askCollectRefund(
  tx: Tx,
  input: {
    tipId: string;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
    absorbGap?: boolean;
  },
  facts: TipRefundFacts,
): Promise<{ refundId: string; amountMinor: string }> {
  const read = await readCollect(tx, input.tipId, facts.profileId!, facts);
  if (read.refusal)
    throw new OperationError('TIP_REFUND_REFUSED', read.refusal);
  if (read.plan === 'wait')
    throw new OperationError('TIP_REFUND_REFUSED', 'in_flight');
  if (read.plan === 'staff_decides' && !input.absorbGap)
    throw new OperationError('TIP_REFUND_REFUSED', 'staff_decides');
  if (read.plan !== 'staff_decides' && input.absorbGap)
    throw new OperationError('TIP_REFUND_REFUSED', 'no_gap');
  const id = newId();
  // C1: what an earlier failed refund holds of their balance (money it took back) moves to this one.
  const failedHolds = await tx
    .select({ heldMinor: tipRefunds.heldMinor })
    .from(tipRefunds)
    .where(
      and(
        eq(tipRefunds.tipId, input.tipId),
        eq(tipRefunds.status, 'FAILED'),
        sql`${tipRefunds.heldMinor} > 0`,
      ),
    )
    .for('update');
  const carriedMinor = failedHolds.reduce((sum, r) => sum + r.heldMinor, 0n);
  if (carriedMinor > 0n)
    await tx
      .update(tipRefunds)
      .set({ heldMinor: 0n, updatedAt: input.now })
      .where(
        and(eq(tipRefunds.tipId, input.tipId), eq(tipRefunds.status, 'FAILED')),
      );
  await tx.insert(tipRefunds).values({
    id,
    tipId: input.tipId,
    status: 'REQUESTED',
    amountMinor: facts.refundMinor,
    currency: 'NGN',
    provider: facts.provider!,
    providerReference: facts.providerReference!,
    requestedBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    collectPlan: read.plan === 'staff_decides' ? 'absorb' : read.plan,
    gapMinor: read.plan === 'staff_decides' ? read.gapMinor : null,
    heldMinor: minOf(read.holdMinor + carriedMinor, facts.refundMinor),
    createdAt: input.now,
    updatedAt: input.now,
  });
  await recordTransition(tx, {
    entityType: 'tip_refund',
    entityId: id,
    fromStatus: null,
    toStatus: 'REQUESTED',
    cause: 'staff',
    traceId: activeTraceId(),
  });
  const { share } = read;
  if (facts.personMinor > 0n && share.state === 'held') {
    const held = await takeUnsentShare(tx, {
      transferId: share.row.id,
      to: 'review',
      reviewReason: 'refund',
      now: input.now,
    });
    if (!held) throw new OperationError('TIP_REFUND_REFUSED', 'in_flight');
  }
  if (read.backMinor > 0n && share.state === 'moved') {
    if (!share.row.accountReference)
      throw new OperationError('TIP_REFUND_REFUSED', 'no_charge');
    // From the account the share went to, where the money is (P26).
    await tx.insert(collectTransfers).values({
      id: newId(),
      kind: 'back',
      tipId: input.tipId,
      profileId: share.row.profileId,
      refundId: id,
      accountReference: share.row.accountReference,
      provider: share.row.provider,
      environment: share.row.environment,
      amountMinor: read.backMinor,
      currency: share.row.currency,
      status: 'waiting',
      idempotencyKey: `tipme-collect-back-${id}`,
      nextTryAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  return { refundId: id, amountMinor: String(facts.refundMinor) };
}

/**
 * RI1: the serious action `tip_refund.return`. What this tip's failed refunds took back from the
 * recipient goes back to the account it came from (a `return` row the collect machine sends, key
 * `tipme-collect-return-<refundId>`). Its paid posting (`provider_clearing` <- held) and the end of
 * the hold are one transaction (`finishPaid`), once. Only with no refund open, no dispute that
 * wasn't won or closed, and nothing already being returned.
 */
export async function returnHeldRefundMoney(
  tx: Tx,
  input: { tipId: string; now: Date },
): Promise<{ returnId: string; amountMinor: string }> {
  const [tip] = await tx
    .select({ id: tips.id })
    .from(tips)
    .where(eq(tips.id, input.tipId))
    .for('update');
  if (!tip) throw new OperationError('TIP_REFUND_REFUSED', 'not_paid');
  const refunds = await tx
    .select()
    .from(tipRefunds)
    .where(eq(tipRefunds.tipId, input.tipId))
    .orderBy(desc(tipRefunds.createdAt))
    .for('update');
  if (refunds.some((r) => r.status !== 'FAILED'))
    throw new OperationError('TIP_REFUND_REFUSED', 'already');
  if (refunds.some((r) => r.refundedMinor !== null))
    throw new OperationError('TIP_REFUND_REFUSED', 'paid_unbooked');
  if (await unsettledDispute(tx, input.tipId))
    throw new OperationError('TIP_REFUND_REFUSED', 'disputed');
  const recovered = await recoveredOnTip(tx, input.tipId);
  if (recovered.returning)
    throw new OperationError('TIP_REFUND_REFUSED', 'in_flight');
  if (recovered.personMinor <= 0n)
    throw new OperationError('TIP_REFUND_REFUSED', 'nothing_held');
  const [from] = await tx
    .select()
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.tipId, input.tipId),
        eq(collectTransfers.kind, 'back'),
        isNotNull(collectTransfers.refundId),
        eq(collectTransfers.status, 'paid'),
      ),
    )
    .orderBy(desc(collectTransfers.createdAt))
    .limit(1);
  const refund = refunds[0];
  if (!from?.accountReference || !refund)
    throw new OperationError('TIP_REFUND_REFUSED', 'nothing_held');
  const id = newId();
  await tx.insert(collectTransfers).values({
    id,
    kind: 'return',
    tipId: input.tipId,
    profileId: from.profileId,
    refundId: refund.id,
    accountReference: from.accountReference,
    provider: from.provider,
    environment: from.environment,
    amountMinor: recovered.personMinor,
    currency: from.currency,
    status: 'ready',
    idempotencyKey: `tipme-collect-return-${refund.id}`,
    nextTryAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return { returnId: id, amountMinor: String(recovered.personMinor) };
}

/**
 * RC1, for a lost dispute's booking (`settleLost`, its transaction): the tip's refunds give way. A
 * refund that may be at the partner (sent, unanswered, or its transfer back or pull-back still
 * moving) makes the dispute wait (`busy`). Otherwise an unsent one fails `disputed`, and what the
 * refunds took back is handed to the dispute (`heldMinor`, to count first: nothing more is taken
 * from the recipient for it); their holds end with the dispute's posting.
 */
export async function yieldRefundsToLostDispute(
  tx: Tx,
  input: { tipId: string; now: Date },
): Promise<
  | { busy: true }
  | { busy: false; heldMinor: bigint; release: () => Promise<void> }
> {
  const rows = await tx
    .select()
    .from(tipRefunds)
    .where(eq(tipRefunds.tipId, input.tipId))
    .for('update');
  for (const row of rows) {
    if (!row.collectPlan) continue;
    if (row.status === 'PROCESSING' || row.status === 'UNKNOWN')
      return { busy: true };
    if (row.status !== 'REQUESTED') continue;
    if (row.sentAt) return { busy: true };
    const { back, pullBack } = await recoveryRows(tx, row);
    if (back && ['ready', 'sent', 'unknown'].includes(back.status))
      return { busy: true };
    if (pullBack && !['done', 'gap', 'review'].includes(pullBack.status))
      return { busy: true };
  }
  const { personMinor, returning } = await recoveredOnTip(tx, input.tipId);
  if (returning) return { busy: true };
  return {
    busy: false,
    heldMinor: personMinor,
    release: async () => {
      for (const row of rows)
        if (row.collectPlan && row.status === 'REQUESTED')
          await failCollectRefund(tx, row, 'disputed', input.now, 'system');
      await tx
        .update(tipRefunds)
        .set({ heldMinor: 0n, updatedAt: input.now })
        .where(eq(tipRefunds.tipId, input.tipId));
    },
  };
}

type RefundRow = typeof tipRefunds.$inferSelect;

async function moveRefund(
  tx: Tx,
  row: RefundRow,
  to: TipRefundStatus,
  input: {
    now: Date;
    cause: 'provider_event' | 'system';
    set?: Partial<typeof tipRefunds.$inferInsert>;
  },
): Promise<void> {
  const from = row.status as TipRefundStatus;
  if (!canTransition(TIP_REFUND_TRANSITIONS, from, to))
    throw new OperationError('INVALID_INPUT');
  await tx
    .update(tipRefunds)
    .set({ status: to, updatedAt: input.now, ...input.set })
    .where(eq(tipRefunds.id, row.id));
  await recordTransition(tx, {
    entityType: 'tip_refund',
    entityId: row.id,
    fromStatus: from,
    toStatus: to,
    cause: input.cause,
    traceId: activeTraceId(),
  });
  row.status = to;
}

/** The key and reference TipMe sends, and the partner's refund events repeat. */
export const tipRefundKey = (refundId: string) =>
  `tipme-tip-refund-${refundId}`;
const KEY_PATTERN =
  /^tipme-tip-refund-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The tip refund a partner event is about, from the reference it repeats; null for any other. */
export const tipRefundIdOf = (reference: string | null | undefined) =>
  KEY_PATTERN.exec(reference ?? '')?.[1] ?? null;

type Failure =
  | 'bank_transfer'
  | 'not_refundable'
  | 'refused'
  | 'partner_failed'
  | 'balance'
  | 'not_recovered'
  | 'disputed';

async function failRefund(
  tx: Tx,
  row: RefundRow,
  failure: Failure,
  now: Date,
  cause: 'provider_event' | 'system',
  /** Said after the reason (a collect refund: what was let go, or what TipMe holds). */
  more = '',
): Promise<void> {
  await moveRefund(tx, row, 'FAILED', { now, cause, set: { failure } });
  const [tip] = await tx
    .select({ profileId: tips.profileId })
    .from(tips)
    .where(eq(tips.id, row.tipId));
  await openIssue(tx, {
    dedupeKey: `tip_refund_failed.${row.id}`,
    kind: 'tip_refund_failed',
    subject: {
      tipId: row.tipId,
      ...(tip?.profileId ? { profileId: tip.profileId } : {}),
    },
    now,
    note:
      (failure === 'bank_transfer'
        ? 'It was paid by bank transfer, which our payment partner can’t refund.'
        : failure === 'partner_failed'
          ? 'Our payment partner reported the refund failed.'
          : failure === 'balance'
            ? `${FAILURE_WORDS['balance']} Nothing was refunded.`
            : failure === 'disputed'
              ? 'A dispute opened on this tip before the refund was sent, so it wasn’t sent (refunding it as well would return the money twice).'
              : failure === 'not_recovered'
                ? 'The recipient’s part couldn’t be taken back first (the transfer back was refused, or the money moved since), so nothing was refunded.'
                : 'Our payment partner refused it (for example, the account couldn’t fund it, or the payment was already refunded).') +
      more,
  });
}

/** The partner calls tip refunds need. */
export interface TipRefundProvider {
  /** You collect: refunds a charge on TipMe's own account, from TipMe's balance (Task 10). */
  refundPlatformCharge?(input: {
    chargeReference: string;
    amountMinor: bigint;
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    refundReference: string;
    status: 'processing' | 'paid' | 'failed';
  }>;
  /** How a collect tip was paid, read from TipMe's own account (a bank transfer can't be refunded). */
  verifyTransaction?(providerReference: string): Promise<{
    method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER';
    chargeReference?: string;
  }>;
  /** TipMe's own balances, signed, every currency. */
  platformBalances?(): Promise<{ currency: string; availableMinor: bigint }[]>;
  refundAccountCharge?(input: {
    providerReference: string;
    amountMinor: bigint;
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    refundReference: string;
    status: 'processing' | 'paid' | 'failed';
  }>;
}

/**
 * Sends approved tip refunds to the partner (with reconciliation, every run): each REQUESTED one
 * once, claimed before the call; one whose answer was lost (UNKNOWN) again with the same key, for 24
 * hours. A definite refusal fails it (nothing moved, staff told). Its outcome comes by webhook.
 */
export async function sendTipRefunds(
  db: Database,
  input: {
    provider: TipRefundProvider;
    providerName: string;
    now: Date;
    limit?: number;
  },
): Promise<{ sent: number; failed: number }> {
  const { now, provider } = input;
  // You collect (Task 10): a collect tip's refund comes from TipMe's own balance.
  const collect = provider.refundPlatformCharge
    ? await sendCollectRefunds(db, input)
    : { sent: 0, failed: 0 };
  if (!provider.refundAccountCharge) return collect;
  const rows = await guarded(() =>
    db
      .select()
      .from(tipRefunds)
      .where(
        and(
          eq(tipRefunds.provider, input.providerName),
          isNull(tipRefunds.collectPlan),
          or(
            and(eq(tipRefunds.status, 'REQUESTED'), isNull(tipRefunds.sentAt)),
            and(
              inArray(tipRefunds.status, ['REQUESTED', 'UNKNOWN']),
              lte(tipRefunds.sentAt, new Date(now.getTime() - RESEND_AFTER_MS)),
            ),
          ),
        ),
      )
      .orderBy(asc(tipRefunds.createdAt))
      .limit(input.limit ?? 20),
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    // Never past the partner's 24 hours for the same key: the webhook still settles it.
    if (
      row.sentAt &&
      now.getTime() - row.createdAt.getTime() > RESEND_WITHIN_MS
    )
      continue;
    // Claim the one call before making it.
    const claimed = await guarded(() =>
      db
        .update(tipRefunds)
        .set({ sentAt: now })
        .where(
          and(
            eq(tipRefunds.id, row.id),
            row.sentAt
              ? eq(tipRefunds.sentAt, row.sentAt)
              : isNull(tipRefunds.sentAt),
          ),
        )
        .returning({ id: tipRefunds.id }),
    );
    if (claimed.length === 0) continue;
    let outcome:
      | { kind: 'answered'; refundReference: string; status: string }
      | {
          kind: 'refused';
          failure: 'bank_transfer' | 'not_refundable' | 'refused';
        }
      | { kind: 'lost' };
    try {
      const answer = await provider.refundAccountCharge({
        providerReference: row.providerReference,
        amountMinor: row.amountMinor,
        reference: tipRefundKey(row.id),
        idempotencyKey: tipRefundKey(row.id),
      });
      outcome = { kind: 'answered', ...answer };
    } catch (error) {
      const reason =
        error instanceof Error && 'reason' in error ? error.reason : null;
      outcome =
        error instanceof Error && error.name === 'TipRefundRefusedError'
          ? {
              kind: 'refused',
              failure:
                reason === 'bank_transfer' || reason === 'not_refundable'
                  ? reason
                  : 'refused',
            }
          : error instanceof Error && error.name === 'BachsRequestNotSentError'
            ? { kind: 'refused', failure: 'refused' }
            : { kind: 'lost' };
    }
    await guarded(() =>
      db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(tipRefunds)
          .where(eq(tipRefunds.id, row.id))
          .for('update');
        if (!locked) return;
        if (locked.status !== 'REQUESTED' && locked.status !== 'UNKNOWN')
          return;
        if (outcome.kind === 'refused') {
          await failRefund(tx, locked, outcome.failure, now, 'system');
          failed += 1;
          return;
        }
        if (outcome.kind === 'answered' && outcome.status === 'failed') {
          await failRefund(tx, locked, 'partner_failed', now, 'system');
          failed += 1;
          return;
        }
        if (outcome.kind === 'lost') {
          if (locked.status === 'REQUESTED')
            await moveRefund(tx, locked, 'UNKNOWN', { now, cause: 'system' });
          return;
        }
        // Accepted; only refund.paid books it, even when the answer already says paid.
        await moveRefund(tx, locked, 'PROCESSING', {
          now,
          cause: 'system',
          set: { providerRefundReference: outcome.refundReference },
        });
        sent += 1;
      }),
    );
  }
  return { sent: sent + collect.sent, failed: failed + collect.failed };
}

type BackRow = typeof collectTransfers.$inferSelect;

/**
 * A collect refund's own transfer back (the person's part), and the tip's business pull-back (one
 * per tip's refunds in practice: a later refund of the tip reuses an earlier one's, C1).
 */
async function recoveryRows(
  db: Database | Tx,
  row: RefundRow,
): Promise<{ back: BackRow | null; pullBack: SweepRow | null }> {
  const [back] = await db
    .select()
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.refundId, row.id),
        eq(collectTransfers.kind, 'back'),
      ),
    );
  const { pullBack } = await recoveredOnTip(db, row.tipId);
  return { back: back ?? null, pullBack };
}

/**
 * A collect refund that won't go ahead (P7). The share held for it is let go: back to the dispute
 * that now holds it when one is unsettled (I1), kept for a closed dispute's refund (P28), else
 * released. A transfer back that never started is cancelled. What it held of the balance is
 * released, unless money already came back for the tip's refund: then TipMe keeps holding it for the
 * tip's next refund, which uses it and takes nothing again (ruling C1), and the issue says so.
 */
async function failCollectRefund(
  tx: Tx,
  row: RefundRow,
  failure: Failure,
  now: Date,
  cause: 'provider_event' | 'system',
): Promise<void> {
  const position = await sharePosition(tx, row.tipId);
  if (position.state === 'held' && position.row.reviewReason === 'refund') {
    const onTip = await tx
      .select({ status: disputes.status, settledAt: disputes.settledAt })
      .from(disputes)
      .where(eq(disputes.tipId, row.tipId));
    const disputed = onTip.some(
      (d) =>
        d.status === 'open' ||
        d.status === 'responded' ||
        (d.status === 'lost' && !d.settledAt),
    );
    const keptForRefund = onTip.some(
      (d) => d.status === 'closed' && !d.settledAt,
    );
    if (disputed)
      // The dispute holds it now (its win releases it, its loss takes it).
      await tx
        .update(collectTransfers)
        .set({ reviewReason: 'dispute', updatedAt: now })
        .where(
          and(
            eq(collectTransfers.id, position.row.id),
            eq(collectTransfers.status, 'review'),
            eq(collectTransfers.reviewReason, 'refund'),
          ),
        );
    else if (!keptForRefund)
      await releaseHeldShare(tx, {
        transferId: position.row.id,
        reason: 'refund',
        now,
      });
  }
  const { back, pullBack } = await recoveryRows(tx, row);
  if (back && (back.status === 'waiting' || back.status === 'review'))
    await tx
      .update(collectTransfers)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          eq(collectTransfers.id, back.id),
          // Never one that may have moved (the database checks it too, P27).
          or(
            eq(collectTransfers.status, 'waiting'),
            and(
              eq(collectTransfers.status, 'review'),
              isNotNull(collectTransfers.refusedAt),
            ),
          ),
        ),
      );
  const recovered = await recoveredOnTip(tx, row.tipId);
  const taken =
    recovered.personMinor +
    (pullBack?.status === 'done' ? pullBack.amountMinor : 0n);
  // The hold reserves only money still in their account and about to come back. Money already back
  // is in held_for_recipients (never withdrawable, Task 12); a transfer back still moving keeps it.
  const backMoving =
    back !== null && ['ready', 'sent', 'unknown'].includes(back.status);
  if (!backMoving)
    await tx
      .update(tipRefunds)
      .set({ heldMinor: 0n, updatedAt: now })
      .where(eq(tipRefunds.id, row.id));
  await failRefund(
    tx,
    row,
    failure,
    now,
    cause,
    taken > 0n
      ? ` ${naira(taken)} had already come back from the recipients for it and is held by TipMe, kept for this tip's refund: asking again uses it and takes nothing twice.`
      : ' Nothing was taken back from the recipients.',
  );
}

/** "₦9,500" (kobo when there are any), as the dispute notes write naira. */
function naira(minor: bigint): string {
  const kobo = minor % 100n;
  const whole = new Intl.NumberFormat('en').format(minor / 100n);
  return `₦${whole}${kobo === 0n ? '' : `.${String(kobo).padStart(2, '0')}`}`;
}

/**
 * Gets a collect refund's money back before it is sent. First, once, before anything moves: how
 * the tip was paid (a bank transfer can't be refunded) and TipMe's balance (too low: refused now,
 * nothing taken back). Then the person's transfer back is released to the collect machine and
 * waited for; then a swept business share is pulled back (Task 9's `collect_recover`, once per
 * refund). A business share still held must still be held (a sweep that raced the refund to the
 * business fails it, nothing moved yet). `recovered` once nothing is left to come back.
 */
async function recoverCollectRefund(
  db: Database,
  given: RefundRow,
  provider: TipRefundProvider,
  now: Date,
): Promise<'recovered' | 'waiting' | 'failed'> {
  const before = await recoveryRows(db, given);
  const started =
    (before.back !== null && before.back.status !== 'waiting') ||
    before.pullBack !== null;
  let refuse: Failure | null = null;
  if (!started) {
    if (provider.verifyTransaction) {
      try {
        const read = await provider.verifyTransaction(given.providerReference);
        if (read.method === 'NGN_BANK_TRANSFER') refuse = 'bank_transfer';
      } catch {
        // Unreadable now: the partner's own refusal still decides later.
      }
    }
    if (!refuse && provider.platformBalances) {
      try {
        const naira = (await provider.platformBalances()).find(
          (b) => b.currency === given.currency,
        );
        if (naira && naira.availableMinor < given.amountMinor)
          refuse = 'balance';
      } catch {
        // As above: the partner refuses a refund it can't fund.
      }
    }
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tipRefunds)
      .where(eq(tipRefunds.id, given.id))
      .for('update');
    if (!row || row.status !== 'REQUESTED' || row.recoveredAt) return 'waiting';
    const { back, pullBack } = await recoveryRows(tx, row);
    if (refuse && (!back || back.status === 'waiting') && !pullBack) {
      await failCollectRefund(tx, row, refuse, now, 'system');
      return 'failed';
    }
    // I1: a dispute opened since the ask stops it before anything more moves.
    const stopped = await disputeStops(tx, row, back, pullBack, now);
    if (stopped) return stopped;
    const [sweep] = (await tx
      .select()
      .from(shareTransfers)
      .where(
        and(
          eq(shareTransfers.tipId, row.tipId),
          eq(shareTransfers.kind, 'collect_sweep'),
        ),
      )
      .for('update')) as SweepRow[];
    // The business's share: still held, or (absorb) swept and to be pulled back.
    if (sweep && sweep.status !== 'cancelled') {
      const held =
        sweep.status === 'out_paid' ||
        (sweep.status === 'review' && sweep.refusedAt !== null);
      if (sweep.status === 'in_sent' || (sweep.status === 'review' && !held))
        return 'waiting';
    }
    // The person's part.
    if (back) {
      if (back.status === 'waiting') {
        await tx
          .update(collectTransfers)
          .set({ status: 'ready', nextTryAt: now, updatedAt: now })
          .where(
            and(
              eq(collectTransfers.id, back.id),
              eq(collectTransfers.status, 'waiting'),
            ),
          );
        return 'waiting';
      }
      if (back.status === 'review' && back.refusedAt) {
        await failCollectRefund(tx, row, 'not_recovered', now, 'system');
        return 'failed';
      }
      if (back.status !== 'paid') return 'waiting';
    }
    // Then a swept business share, pulled back from the business's account.
    if (sweep?.status === 'done' && sweep.businessId) {
      if (!pullBack) {
        await scheduleCollectRecover(tx, {
          tipId: row.tipId,
          tipRefundId: row.id,
          businessId: sweep.businessId,
          profileId: sweep.profileId,
          amountMinor: sweep.deliverMinor ?? sweep.amountMinor,
          currency: sweep.currency,
          provider: sweep.provider,
          now,
        });
        return 'waiting';
      }
      if (pullBack.status !== 'done' && pullBack.status !== 'gap')
        return 'waiting';
      // What the pull-back couldn't find is TipMe's only if a second person decided so (absorb);
      // otherwise nothing is refunded, and what came back is kept for the tip's next refund (C1).
      const owed = sweep.deliverMinor ?? sweep.amountMinor;
      const got = pullBack.status === 'done' ? pullBack.amountMinor : 0n;
      if (got < owed && row.collectPlan !== 'absorb') {
        await failCollectRefund(tx, row, 'not_recovered', now, 'system');
        return 'failed';
      }
    }
    await tx
      .update(tipRefunds)
      .set({ recoveredAt: now, updatedAt: now })
      .where(eq(tipRefunds.id, row.id));
    return 'recovered';
  });
}

/** Sends that never left this many times in a row tell staff (RM1). */
const NOT_SENT_ALERT_AFTER = 5;
/** A collect refund waiting this long for money to come back is raised to staff (once). */
const RECOVERY_ALERT_MS = 24 * 3_600_000;
/** The partner's 400 codes that mean TipMe's own balance can't fund the refund. */
const BALANCE_CODES = new Set(['INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS']);

/**
 * I1, RC1: a dispute on the tip that wasn't won or closed stops its refund for good (it would return
 * the money twice): the refund fails `disputed` and is never sent by the worker again. The share
 * held for it goes to the dispute; money already taken back stays held for the tip, and a lost
 * dispute uses it first (`settleLost`). A won dispute leaves it held: a new staff ask reuses it, or
 * staff return it (`tip_refund.return`).
 */
async function disputeStops(
  tx: Tx,
  row: RefundRow,
  back: BackRow | null,
  pullBack: SweepRow | null,
  now: Date,
): Promise<'failed' | 'waiting' | null> {
  if (!(await unsettledDispute(tx, row.tipId))) return null;
  // RC2: a refund that may already be at the partner (sent, its answer lost, or claimed before a
  // crash) is never failed: it may be made. It stays as it is, unsent again, and only the partner's
  // event (or staff) settles it; its share stays held for it, so a won dispute releases nothing.
  if (row.status === 'UNKNOWN' || row.sentAt || row.firstSentAt) {
    await openIssue(tx, {
      dedupeKey: `tip_refund_disputed_unknown.${row.id}`,
      kind: 'collect_recon_mismatch',
      subject: { tipId: row.tipId },
      note: `A dispute opened on this collect tip while its refund (${tipRefundKey(row.id)}) may already have been made: TipMe asked our payment partner (Bachs) and never heard back. The refund is not sent again and not cancelled; the share stays held. Check the partner's refunds for that reference; a refund there is evidence for the dispute.`,
      now,
    });
    return 'waiting';
  }
  // RC1: stopped for good, never sent by the worker. Only a transfer back or pull-back still in
  // flight is waited for (its money must land before the refund lets go of its hold).
  const backMoving =
    back !== null && ['ready', 'sent', 'unknown'].includes(back.status);
  const pullMoving =
    pullBack !== null && !['done', 'gap', 'review'].includes(pullBack.status);
  if (backMoving || pullMoving) return 'waiting';
  await failCollectRefund(tx, row, 'disputed', now, 'system');
  return 'failed';
}

/**
 * Claims one collect refund's send (before the call): only once recovered, never on a tip with a
 * dispute that wasn't won or closed, never on a tip whose money already went back (a reversal), and
 * only as this worker last saw it (`sent_at`). The key's window opens at the first claim (I2).
 */
async function claimRow(
  db: Database,
  row: RefundRow,
  now: Date,
): Promise<boolean> {
  const claimed = await db
    .update(tipRefunds)
    .set({
      sentAt: now,
      firstSentAt: sql`COALESCE(${tipRefunds.firstSentAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(tipRefunds.id, row.id),
        isNotNull(tipRefunds.recoveredAt),
        sql`NOT EXISTS (SELECT 1 FROM disputes x WHERE x.tip_id = ${tipRefunds.tipId}
              AND x.status IN ('open', 'responded', 'lost'))`,
        sql`NOT EXISTS (SELECT 1 FROM ledger_transactions l WHERE l.tip_id = ${tipRefunds.tipId}
              AND l.operation_type = 'reversal')`,
        row.sentAt
          ? eq(tipRefunds.sentAt, row.sentAt)
          : isNull(tipRefunds.sentAt),
      ),
    )
    .returning({ id: tipRefunds.id });
  return claimed.length === 1;
}

/** The send claim on its own (the guards behind `disputeStops`, pinned by tests: RM4). */
export function claimCollectRefund(
  db: Database,
  input: { refundId: string; now: Date },
): Promise<boolean> {
  return guarded(async () => {
    const [row] = await db
      .select()
      .from(tipRefunds)
      .where(eq(tipRefunds.id, input.refundId));
    return row ? claimRow(db, row, input.now) : false;
  });
}

/**
 * The collect half of the sender: each REQUESTED collect refund is recovered first, then sent once
 * from TipMe's own account (claimed before the call, the same key for 24 hours after a lost
 * answer), as the direct sender does. A refusal fails it, and what was held for it is let go.
 */
async function sendCollectRefunds(
  db: Database,
  input: {
    provider: TipRefundProvider;
    providerName: string;
    now: Date;
    limit?: number;
  },
): Promise<{ sent: number; failed: number }> {
  const { now, provider } = input;
  const refund = provider.refundPlatformCharge!;
  const rows = await guarded(() =>
    db
      .select()
      .from(tipRefunds)
      .where(
        and(
          eq(tipRefunds.provider, input.providerName),
          isNotNull(tipRefunds.collectPlan),
          // RM1: a send that never left waits out its backoff.
          or(isNull(tipRefunds.retryAfter), lte(tipRefunds.retryAfter, now)),
          or(
            and(eq(tipRefunds.status, 'REQUESTED'), isNull(tipRefunds.sentAt)),
            and(
              inArray(tipRefunds.status, ['REQUESTED', 'UNKNOWN']),
              lte(tipRefunds.sentAt, new Date(now.getTime() - RESEND_AFTER_MS)),
            ),
          ),
        ),
      )
      .orderBy(asc(tipRefunds.createdAt))
      // Refunds waiting for money to come back are looked at every run: room for them and new ones.
      .limit(input.limit ?? 100),
  );
  let sent = 0;
  let failed = 0;
  for (const given of rows) {
    let row = given;
    if (!row.recoveredAt) {
      let step: 'recovered' | 'waiting' | 'failed';
      try {
        step = await guarded(() =>
          recoverCollectRefund(db, row, provider, now),
        );
      } catch {
        continue; // One refund's trouble never stops the others.
      }
      if (step === 'failed') failed += 1;
      if (
        step === 'waiting' &&
        now.getTime() - row.createdAt.getTime() > RECOVERY_ALERT_MS
      )
        await guarded(() =>
          openIssue(db, {
            dedupeKey: `tip_refund_waiting.${row.id}`,
            kind: 'collect_transfer_stuck',
            subject: { tipId: row.tipId },
            note: `A collect tip's refund has waited over a day for the recipient's part to come back (a transfer back or a business pull-back). Nothing has been refunded yet.`,
            now,
          }),
        );
      if (step !== 'recovered') continue;
      const [fresh] = await guarded(() =>
        db.select().from(tipRefunds).where(eq(tipRefunds.id, row.id)),
      );
      if (!fresh) continue;
      row = fresh;
    }
    // I2 (P24): the partner replays the key from its first send; past the trusted window, never a
    // blind resend. There is no refund read-back by key, so a person checks the partner's records.
    if (
      row.firstSentAt &&
      now.getTime() - row.firstSentAt.getTime() >= KEY_TRUSTED_FOR_MS
    ) {
      await guarded(() =>
        openIssue(db, {
          dedupeKey: `tip_refund_unknown.${row.id}`,
          kind: 'tip_refund_failed',
          subject: { tipId: row.tipId },
          note: `TipMe asked our payment partner for this collect tip's refund (${tipRefundKey(row.id)}) but never heard whether it was made, and the partner no longer replays that request. It is not sent again: check the partner's refunds for that reference.`,
          now,
        }),
      );
      continue;
    }
    // I1: a dispute that opened while the money came back stops it here too.
    const stopped = await guarded(() =>
      db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(tipRefunds)
          .where(eq(tipRefunds.id, row.id))
          .for('update');
        if (
          !locked ||
          (locked.status !== 'REQUESTED' && locked.status !== 'UNKNOWN')
        )
          return 'waiting' as const;
        const { back, pullBack } = await recoveryRows(tx, locked);
        return disputeStops(tx, locked, back, pullBack, now);
      }),
    );
    if (stopped === 'failed') failed += 1;
    if (stopped) continue;
    // The charge on TipMe's own account: the one the payment confirmed, stored on its share.
    const [share] = await guarded(() =>
      db
        .select({ chargeReference: collectTransfers.chargeReference })
        .from(collectTransfers)
        .where(
          and(
            eq(collectTransfers.tipId, row.tipId),
            eq(collectTransfers.kind, 'share'),
          ),
        ),
    );
    const chargeReference = share?.chargeReference ?? null;
    const claimed = await guarded(() => claimRow(db, row, now));
    if (!claimed) continue;
    let outcome:
      | { kind: 'answered'; refundReference: string; status: string }
      | { kind: 'refused'; failure: Failure }
      | { kind: 'not_sent' }
      | { kind: 'lost' };
    if (!chargeReference)
      outcome = { kind: 'refused', failure: 'not_refundable' };
    else
      try {
        const answer = await refund.call(provider, {
          chargeReference,
          amountMinor: row.amountMinor,
          reference: tipRefundKey(row.id),
          idempotencyKey: tipRefundKey(row.id),
        });
        outcome = { kind: 'answered', ...answer };
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        // The partner's 400s on TipMe's own account ("Insufficient balance to refund") create
        // nothing; a request never sent moved nothing either.
        const code = (error as { providerCode?: unknown }).providerCode;
        // M1: the adapter raises this for every 400; only a balance code means TipMe's balance.
        outcome =
          name === 'ProRefundRefusedError'
            ? {
                kind: 'refused',
                failure:
                  typeof code === 'string' && BALANCE_CODES.has(code)
                    ? 'balance'
                    : 'refused',
              }
            : name === 'BachsRequestNotSentError'
              ? { kind: 'not_sent' }
              : { kind: 'lost' };
      }
    await guarded(() =>
      db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(tipRefunds)
          .where(eq(tipRefunds.id, row.id))
          .for('update');
        if (!locked) return;
        if (locked.status !== 'REQUESTED' && locked.status !== 'UNKNOWN')
          return;
        if (outcome.kind === 'not_sent') {
          // C1: nothing reached the partner, and the money is back: tried again (the claim undone,
          // the key's window unopened), never failed. RM1: after a backoff (5 minutes, doubling,
          // at most 6 hours, as collect transfers), and staff are told once it keeps happening.
          const count = locked.notSentCount + 1;
          const wait = Math.min(5 * 2 ** (count - 1), 360) * 60_000;
          await tx
            .update(tipRefunds)
            .set({
              sentAt: row.sentAt,
              firstSentAt: row.firstSentAt,
              notSentCount: count,
              retryAfter: new Date(now.getTime() + wait),
            })
            .where(eq(tipRefunds.id, locked.id));
          if (count >= NOT_SENT_ALERT_AFTER)
            await openIssue(tx, {
              dedupeKey: `tip_refund_not_sent.${locked.id}`,
              kind: 'collect_transfer_stuck',
              subject: { tipId: locked.tipId },
              note: `A collect tip's refund (${tipRefundKey(locked.id)}) couldn't be sent to our payment partner ${count} times (the request never left: check the charge reference and the partner settings). It is still tried again, at most every 6 hours.`,
              now,
            });
          return;
        }
        if (outcome.kind === 'refused') {
          await failCollectRefund(tx, locked, outcome.failure, now, 'system');
          failed += 1;
          return;
        }
        if (outcome.kind === 'answered' && outcome.status === 'failed') {
          await failCollectRefund(tx, locked, 'partner_failed', now, 'system');
          failed += 1;
          return;
        }
        if (outcome.kind === 'lost') {
          if (locked.status === 'REQUESTED')
            await moveRefund(tx, locked, 'UNKNOWN', { now, cause: 'system' });
          return;
        }
        await moveRefund(tx, locked, 'PROCESSING', {
          now,
          cause: 'system',
          set: { providerRefundReference: outcome.refundReference },
        });
        sent += 1;
      }),
    );
  }
  return { sent, failed };
}

/**
 * refund.paid for a collect tip: the money left TipMe's balance. In one transaction: the share held
 * for it is cancelled (now, never before, P7), a business share TipMe still held is taken, and what
 * came back (the transfer back, the business's pull-back) is given back from the recipients'
 * payables; TipMe absorbs only what didn't come back (`refund_loss_expense`, R6). Booked once as a
 * reversal of the payment (`collect_refund.<refundId>`). A closed dispute's hold kept for this
 * refund is consumed: settled, never released to the recipient (P28).
 */
async function bookCollectRefund(
  tx: Tx,
  row: RefundRow,
  refundedMinor: bigint,
  feeMinor: bigint,
  now: Date,
): Promise<void> {
  const facts = await tipRefundFacts(tx, row.tipId);
  const profileId = facts.profileId!;
  const parts: ({ amountMinor: bigint } & Owner)[] = [];
  const position = await sharePosition(tx, row.tipId);
  const { pullBack } = await recoveryRows(tx, row);
  if (facts.personMinor > 0n) {
    if (position.state === 'held') {
      const took = await takeUnsentShare(tx, {
        transferId: position.row.id,
        to: 'cancelled',
        reviewReason: 'refund',
        now,
      });
      if (!took) throw new Error('a share held for a refund moved under it');
      parts.push({ amountMinor: position.row.amountMinor, profileId });
    } else {
      // Every transfer back this tip's refunds took (an earlier failed ask's included, C1).
      const { personMinor } = await recoveredOnTip(tx, row.tipId);
      if (personMinor > 0n)
        parts.push({
          amountMinor: minOf(personMinor, facts.personMinor),
          profileId,
        });
    }
  }
  if (facts.businessMinor > 0n) {
    const [sweep] = (await tx
      .select()
      .from(shareTransfers)
      .where(
        and(
          eq(shareTransfers.tipId, row.tipId),
          eq(shareTransfers.kind, 'collect_sweep'),
        ),
      )
      .for('update')) as SweepRow[];
    if (sweep?.businessId) {
      const owed = sweep.deliverMinor ?? sweep.amountMinor;
      const [taken] = await tx
        .update(shareTransfers)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(shareTransfers.id, sweep.id),
            or(
              eq(shareTransfers.status, 'out_paid'),
              and(
                eq(shareTransfers.status, 'review'),
                isNotNull(shareTransfers.refusedAt),
              ),
            ),
          ),
        )
        .returning({ id: shareTransfers.id });
      if (taken)
        parts.push({ amountMinor: owed, businessId: sweep.businessId });
      else if (pullBack?.status === 'done')
        parts.push({
          amountMinor: minOf(pullBack.amountMinor, owed),
          businessId: sweep.businessId,
        });
    }
  }
  // What the supporter got is what left TipMe's balance: recovered parts first, the rest TipMe's.
  let left = refundedMinor;
  const used: typeof parts = [];
  for (const part of parts) {
    const amountMinor = minOf(part.amountMinor, left);
    if (amountMinor > 0n) used.push({ ...part, amountMinor });
    left -= amountMinor;
  }
  const absorbed = left;
  if (
    absorbed > 0n &&
    (row.collectPlan !== 'absorb' || absorbed > (row.gapMinor ?? 0n))
  )
    // Booked as it happened (the money is gone), and a person looks at why it wasn't recovered.
    await openIssue(tx, {
      dedupeKey: `tip_refund_gap.${row.id}`,
      kind: 'collect_recon_mismatch',
      subject: { tipId: row.tipId, profileId },
      note: `The refund of this collect tip was paid, but ${naira(absorbed)} of it hadn't been recovered from the recipients${row.collectPlan === 'absorb' ? ` (more than the ${naira(row.gapMinor ?? 0n)} staff approved)` : ''}. TipMe absorbed it.`,
      now,
    });
  const recovered = parts.reduce((sum, p) => sum + p.amountMinor, 0n);
  if (recovered > refundedMinor)
    await openIssue(tx, {
      dedupeKey: `tip_refund_short.${row.id}`,
      kind: 'collect_recon_mismatch',
      subject: { tipId: row.tipId, profileId },
      note: `The partner refunded ${naira(refundedMinor)} of this collect tip, less than the ${naira(recovered)} taken back for it. The rest is held by TipMe for the recipients.`,
      now,
    });
  const lines: LedgerLine[] = [
    ...(used.length > 0
      ? buildCollectRefundPosting({ parts: used, refundFeeMinor: feeMinor })
      : []),
    ...(absorbed > 0n
      ? buildAbsorbedRefundPosting({
          amountMinor: absorbed,
          ...(used.length === 0 ? { refundFeeMinor: feeMinor } : {}),
        })
      : []),
  ];
  const [payment] = await tx
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.tipId, row.tipId),
        eq(ledgerTransactions.operationType, 'payment'),
      ),
    );
  if (!payment) throw new Error('a collect tip has its payment posting');
  if (lines.length > 0)
    await postLedgerTransaction(tx, {
      operationType: 'reversal',
      operationKey: `collect_refund.${row.id}`,
      currency: row.currency,
      tipId: row.tipId,
      reversesTransactionId: payment.id,
      traceId: activeTraceId(),
      lines,
    });
  // RC2: a lost dispute on the tip as well: both went out.
  const [lost] = await tx
    .select({ amountMinor: disputes.amountMinor })
    .from(disputes)
    .where(and(eq(disputes.tipId, row.tipId), eq(disputes.status, 'lost')));
  if (lost)
    await tellRefundAndDispute(tx, {
      tipId: row.tipId,
      refundMinor: refundedMinor,
      disputeMinor: lost.amountMinor,
      now,
    });
  // P28: the hold a closed dispute kept for this refund is consumed now, once.
  await tx
    .update(disputes)
    .set({ heldMinor: 0n, settledAt: now, updatedAt: now })
    .where(
      and(
        eq(disputes.tipId, row.tipId),
        eq(disputes.status, 'closed'),
        isNull(disputes.settledAt),
      ),
    );
}

/**
 * A partner refund event about a tip refund TipMe asked for (it repeats `tipme-tip-refund-<id>`).
 * Pending: noted. Paid: booked once by `reverseTip` under the refund rule (each side gives back what
 * it received; TipMe keeps its fee), then PAID. Failed: nothing moved, staff told.
 */
export async function applyTipRefundEvent(
  db: Database,
  input: {
    tipRefundId: string;
    refundState: 'pending' | 'paid' | 'failed';
    /** The partner's refund, as `refund.<id>`. */
    partnerReversalId: string | null;
    refundedMinor: bigint | null;
    refundFeeMinor: bigint | null;
    now: Date;
  },
): Promise<'noted' | 'refunded' | 'failed' | 'already'> {
  const { now } = input;
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tipRefunds)
        .where(eq(tipRefunds.id, input.tipRefundId))
        .for('update');
      if (!row) throw new OperationError('INVALID_INPUT');
      const partnerRef = input.partnerReversalId?.startsWith('refund.')
        ? input.partnerReversalId.slice('refund.'.length)
        : null;
      // RC1 (defence in depth): a collect refund paid that TipMe didn't expect to be sent (it was
      // stopped or failed), or whose tip's money already went back another way (a lost dispute),
      // is never booked twice and never dropped: a money issue names it, and what it held stays
      // reserved for a person to settle.
      if (
        row.collectPlan &&
        input.refundState === 'paid' &&
        row.status !== 'PAID' &&
        (row.status === 'FAILED' || (await tipReversed(tx, row.tipId)))
      ) {
        await openIssue(tx, {
          dedupeKey: `tip_refund_unexpected.${row.id}`,
          kind: 'collect_recon_mismatch',
          subject: { tipId: row.tipId },
          note: `Our payment partner (Bachs) reports refund ${tipRefundKey(row.id)} of ${naira(input.refundedMinor ?? row.amountMinor)} paid, but TipMe had stopped it, or the tip's money had already gone back (a lost dispute). Nothing was booked: settle it by hand. ${naira(row.heldMinor)} is still held from the recipient for it.`,
          now,
        });
        // RI3: the tip can't be refunded again; staff see what wasn't booked.
        await tx
          .update(tipRefunds)
          .set({
            refundedMinor: input.refundedMinor ?? row.amountMinor,
            ...(partnerRef ? { providerRefundReference: partnerRef } : {}),
            updatedAt: now,
          })
          .where(eq(tipRefunds.id, row.id));
        return 'noted';
      }
      if (row.status === 'PAID' || row.status === 'FAILED') return 'already';
      if (input.refundState === 'pending') {
        if (row.status !== 'PROCESSING')
          await moveRefund(tx, row, 'PROCESSING', {
            now,
            cause: 'provider_event',
            ...(partnerRef
              ? { set: { providerRefundReference: partnerRef } }
              : {}),
          });
        return 'noted';
      }
      if (input.refundState === 'failed') {
        if (row.collectPlan)
          await failCollectRefund(
            tx,
            row,
            'partner_failed',
            now,
            'provider_event',
          );
        else await failRefund(tx, row, 'partner_failed', now, 'provider_event');
        return 'failed';
      }
      const refunded = input.refundedMinor ?? row.amountMinor;
      const fee = input.refundFeeMinor ?? 0n;
      if (row.collectPlan) {
        await bookCollectRefund(tx, row, refunded, fee, now);
        await moveRefund(tx, row, 'PAID', {
          now,
          cause: 'provider_event',
          set: {
            refundedMinor: refunded,
            refundFeeMinor: fee,
            heldMinor: 0n,
            ...(partnerRef ? { providerRefundReference: partnerRef } : {}),
          },
        });
        return 'refunded';
      }
      await reverseTip(tx, {
        tipId: row.tipId,
        // Keyed on the partner's refund when it names one, else on TipMe's own refund: once.
        partnerReversalId: partnerRef
          ? `refund.${partnerRef}`
          : `refund.${tipRefundKey(row.id)}`,
        refundedMinor: refunded,
        refundFeeMinor: fee,
        now,
      });
      await moveRefund(tx, row, 'PAID', {
        now,
        cause: 'provider_event',
        set: {
          refundedMinor: refunded,
          refundFeeMinor: fee,
          ...(partnerRef ? { providerRefundReference: partnerRef } : {}),
        },
      });
      return 'refunded';
    }),
  );
}

/** A paid tip refund, for the supporter's receipt: what they got back. Null when none. */
export async function paidTipRefund(
  db: Database | Tx,
  tipId: string,
): Promise<{ refundedMinor: bigint } | null> {
  const [row] = await guarded(() =>
    db
      .select({
        refundedMinor: tipRefunds.refundedMinor,
        amountMinor: tipRefunds.amountMinor,
      })
      .from(tipRefunds)
      .where(and(eq(tipRefunds.tipId, tipId), eq(tipRefunds.status, 'PAID'))),
  );
  return row ? { refundedMinor: row.refundedMinor ?? row.amountMinor } : null;
}

/** Keeps the page lookup local: who the tip's page is (for the serious action's subjects). */
export async function tipRefundPage(
  db: Database | Tx,
  tipId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ profileId: tips.profileId })
    .from(tips)
    .innerJoin(profiles, eq(profiles.id, tips.profileId))
    .where(eq(tips.id, tipId));
  return row?.profileId ?? null;
}

/** Whether TipMe asked for this tip refund (a partner event may repeat a reference of another copy). */
export async function findTipRefund(
  db: Database | Tx,
  tipRefundId: string,
): Promise<{ id: string } | null> {
  const [row] = await guarded(() =>
    db
      .select({ id: tipRefunds.id })
      .from(tipRefunds)
      .where(eq(tipRefunds.id, tipRefundId)),
  );
  return row ?? null;
}
