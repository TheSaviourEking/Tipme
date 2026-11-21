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
  | 'disputed';

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
};

/** Why the last refund of a tip failed, for staff (nothing moved unless the issue says so). */
const FAILURE_WORDS: Record<string, string> = {
  bank_transfer: REFUSAL_WORDS.bank_transfer,
  balance: "TipMe's balance can't cover this refund right now.",
  not_recovered:
    'The recipient’s part couldn’t be taken back, so nothing was refunded.',
  not_refundable: 'Our payment partner said this payment can’t be refunded.',
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
    })
    .from(tipRefunds)
    .where(eq(tipRefunds.tipId, tipId))
    .orderBy(desc(tipRefunds.createdAt));
  const open = rows.find((r) => r.status !== 'FAILED') ?? null;
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
    lastFailure:
      !open && latest?.status === 'FAILED'
        ? (FAILURE_WORDS[latest.failure ?? ''] ?? FAILURE_WORDS['refused']!)
        : null,
  };
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
}

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

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
  const base = {
    gapMinor: 0n,
    share,
    backMinor: 0n,
    holdMinor: 0n,
    chargeReference: share.row?.chargeReference ?? null,
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
  const keptForRefund = onTip
    .filter((d) => d.status === 'closed' && !d.settledAt)
    .reduce((sum, d) => sum + d.heldMinor, 0n);
  let wait = false;
  let gap = 0n;
  let moved = false;
  let backMinor = 0n;
  let holdMinor = 0n;
  const person = parts.personMinor;
  if (person > 0n) {
    if (share.state === 'in_flight') wait = true;
    else if (share.state === 'gone')
      return { ...base, plan: 'wait', refusal: 'already' };
    else if (share.state === 'held') holdMinor = person;
    else {
      moved = true;
      const { availableMinor } = await balanceIn(db, profileId);
      const inBalance = minOf(
        share.row.amountMinor,
        (availableMinor > 0n ? availableMinor : 0n) + keptForRefund,
      );
      const plan = collectRefundPlan({
        refundMinor: person,
        share: { state: 'moved', inBalanceMinor: inBalance },
      });
      if (plan.kind === 'take_back') backMinor = plan.backMinor;
      else if (plan.kind === 'staff_decides') {
        gap += plan.gapMinor;
        backMinor = person - plan.gapMinor;
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
    if (status === 'in_sent' || (status === 'review' && !sweep?.refusedAt))
      wait = true;
    else if (status === 'done') gap += parts.businessMinor;
    else if (status !== 'out_paid' && status !== 'review')
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
    heldMinor: read.holdMinor,
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
  | 'not_recovered';

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
type SweepRow = typeof shareTransfers.$inferSelect;

/** A collect refund's own transfer back (the person's part), and its business pull-back. */
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
  const [pullBack] = await db
    .select()
    .from(shareTransfers)
    .where(
      and(
        eq(shareTransfers.tipRefundId, row.id),
        eq(shareTransfers.kind, 'collect_recover'),
      ),
    );
  return { back: back ?? null, pullBack: pullBack ?? null };
}

/**
 * A collect refund that won't go ahead (P7): the share held for it is let go (unless a closed
 * dispute keeps it for a refund, P28), a transfer back that never started is cancelled, and what it
 * held of the balance is released, unless money already came back for it: then TipMe holds that,
 * the hold stays, and the issue says so (staff ask the refund again or return it).
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
    const [kept] = await tx
      .select({ id: disputes.id })
      .from(disputes)
      .where(
        and(
          eq(disputes.tipId, row.tipId),
          eq(disputes.status, 'closed'),
          isNull(disputes.settledAt),
        ),
      );
    if (!kept)
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
  const taken =
    (back?.status === 'paid' ? back.amountMinor : 0n) +
    (pullBack?.status === 'done' ? pullBack.amountMinor : 0n);
  if (taken === 0n)
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
      ? ` ${naira(taken)} had already been taken back for it and is held by TipMe: ask the refund again, or return it.`
      : ' Nothing was taken back from the recipient.',
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
      if (!held && sweep.status === 'done' && row.collectPlan !== 'absorb') {
        await failCollectRefund(tx, row, 'not_recovered', now, 'system');
        return 'failed';
      }
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
    }
    await tx
      .update(tipRefunds)
      .set({ recoveredAt: now, updatedAt: now })
      .where(eq(tipRefunds.id, row.id));
    return 'recovered';
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
      if (step !== 'recovered') continue;
      const [fresh] = await guarded(() =>
        db.select().from(tipRefunds).where(eq(tipRefunds.id, row.id)),
      );
      if (!fresh) continue;
      row = fresh;
    }
    if (
      row.sentAt &&
      now.getTime() - row.createdAt.getTime() > RESEND_WITHIN_MS
    )
      continue;
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
    const claimed = await guarded(() =>
      db
        .update(tipRefunds)
        .set({ sentAt: now })
        .where(
          and(
            eq(tipRefunds.id, row.id),
            isNotNull(tipRefunds.recoveredAt),
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
      | { kind: 'refused'; failure: Failure }
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
        outcome =
          name === 'ProRefundRefusedError'
            ? { kind: 'refused', failure: 'balance' }
            : name === 'BachsRequestNotSentError'
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
  const { back, pullBack } = await recoveryRows(tx, row);
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
    } else if (back?.status === 'paid')
      parts.push({ amountMinor: back.amountMinor, profileId });
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
