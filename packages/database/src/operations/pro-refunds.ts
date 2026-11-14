import {
  buildProRefundPosting,
  canTransition,
  PRO_REFUND_TRANSITIONS,
  type ProRefundStatus,
} from '@tipme/domain';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { proPeriods, proPurchases, proRefunds } from '../schema.js';
import { personOf } from './owner.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { endPaidMonth, lockPurchase } from './pro-purchases.js';
import { recordTransition } from './transitions.js';

/*
 * Pro refunds, card only (plan Task 9; ruling 6). Staff ask on the member's request, within 14 days
 * of payment, and a second person decides (`pro.refund`, a serious action). Approving only records
 * the refund (REQUESTED): the worker sends it to the partner once, with the key
 * `tipme-pro-refund-<id>` (the same key on the same payment returns the same refund for 24 hours).
 * Only `refund.paid` books the reversal (`pro_refund.<purchaseId>`: Pro revenue back out of TipMe's
 * own balance; the card fee stays TipMe's) and ends that paid month at once, unless a staff grant or
 * another month still covers now. `refund.failed` changes nothing about Pro and raises a money issue;
 * a failed refund doesn't count, so it can be asked again. Bank-transfer months can't be refunded
 * through the partner, and balance months aren't refunded in v1.
 */

/** Ruling 6: within 14 days of payment. */
export const PRO_REFUND_WINDOW_MS = 14 * 86_400_000;
/** The partner returns the same refund for the same key for 24 hours; after that, never resent. */
const RESEND_WITHIN_MS = 24 * 3_600_000;
const RESEND_AFTER_MS = 2 * 60_000;

export type ProRefundRefusal =
  | 'not_paid'
  | 'bank_transfer'
  | 'balance'
  | 'too_late'
  | 'already'
  | 'no_charge';

/** What staff read, in plain words (the partner may be named on staff screens; here it isn't). */
const REFUSAL_WORDS: Record<ProRefundRefusal, string> = {
  not_paid: 'Only a paid Pro month can be refunded.',
  bank_transfer:
    'This payment was made by bank transfer, so it can’t be refunded through our payment partner. Any return is handled outside TipMe.',
  balance:
    'This month was paid from the TipMe balance. Balance payments aren’t refunded.',
  too_late: 'Pro payments can be refunded within 14 days of payment only.',
  already: 'This payment already has a refund in progress or paid.',
  no_charge:
    'The payment partner hasn’t told TipMe which charge this was, so it can’t be refunded from here.',
};

export interface ProRefundFacts {
  refundable: boolean;
  refusal: ProRefundRefusal | null;
  words: string;
  amountMinor: bigint | null;
  paidAt: Date | null;
  paidBy: string | null;
  profileId: string | null;
  /** A Business Pro month's business (then `profileId` is null). */
  businessId: string | null;
  refund: { id: string; status: ProRefundStatus } | null;
}

/** Whether a purchase can be refunded now, and why not. Read under the purchase lock to act on. */
export async function proRefundFacts(
  db: Database | Tx,
  purchaseId: string,
  now: Date,
): Promise<ProRefundFacts> {
  const [purchase] = await db
    .select()
    .from(proPurchases)
    .where(eq(proPurchases.id, purchaseId));
  const [period] = purchase
    ? await db
        .select({ paidBy: proPeriods.paidBy })
        .from(proPeriods)
        .where(eq(proPeriods.purchaseId, purchaseId))
    : [];
  const [refund] = purchase
    ? await db
        .select({ id: proRefunds.id, status: proRefunds.status })
        .from(proRefunds)
        .where(
          and(
            eq(proRefunds.purchaseId, purchaseId),
            ne(proRefunds.status, 'FAILED'),
          ),
        )
    : [];
  const paidBy = period?.paidBy ?? null;
  const refusal: ProRefundRefusal | null =
    !purchase || purchase.status !== 'PAID' || !purchase.paidAt
      ? 'not_paid'
      : paidBy === 'bank_transfer'
        ? 'bank_transfer'
        : purchase.method === 'balance' || paidBy === 'balance'
          ? 'balance'
          : now.getTime() - purchase.paidAt.getTime() > PRO_REFUND_WINDOW_MS
            ? 'too_late'
            : refund
              ? 'already'
              : !purchase.chargeReference
                ? 'no_charge'
                : null;
  return {
    refundable: refusal === null,
    refusal,
    words: refusal
      ? REFUSAL_WORDS[refusal]
      : 'This card payment can be refunded.',
    amountMinor: purchase?.amountMinor ?? null,
    paidAt: purchase?.paidAt ?? null,
    paidBy,
    profileId: purchase?.profileId ?? null,
    businessId: purchase?.businessId ?? null,
    refund: refund
      ? { id: refund.id, status: refund.status as ProRefundStatus }
      : null,
  };
}

/**
 * The serious action's work (`pro.refund`): checks again under the purchase's lock and records the
 * approved refund for the worker to send. Moves no money and changes no plan.
 */
export async function askProRefund(
  tx: Tx,
  input: {
    purchaseId: string;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ refundId: string; amountMinor: string }> {
  const row = await lockPurchase(tx, input.purchaseId).catch(() => null);
  if (!row) throw new OperationError('PRO_REFUND_REFUSED', 'not_paid');
  const facts = await proRefundFacts(tx, input.purchaseId, input.now);
  if (!facts.refundable)
    throw new OperationError('PRO_REFUND_REFUSED', facts.refusal ?? 'not_paid');
  const id = newId();
  await tx.insert(proRefunds).values({
    id,
    purchaseId: row.id,
    status: 'REQUESTED',
    amountMinor: row.amountMinor,
    currency: row.currency,
    requestedBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await recordTransition(tx, {
    entityType: 'pro_refund',
    entityId: id,
    fromStatus: null,
    toStatus: 'REQUESTED',
    cause: 'staff',
    traceId: activeTraceId(),
  });
  return { refundId: id, amountMinor: String(row.amountMinor) };
}

type RefundRow = typeof proRefunds.$inferSelect;

async function moveRefund(
  tx: Tx,
  row: RefundRow,
  to: ProRefundStatus,
  input: {
    now: Date;
    cause: 'provider_event' | 'system';
    providerEventId?: string;
    set?: Partial<typeof proRefunds.$inferInsert>;
  },
): Promise<void> {
  const from = row.status as ProRefundStatus;
  if (!canTransition(PRO_REFUND_TRANSITIONS, from, to))
    throw new OperationError('INVALID_INPUT');
  await tx
    .update(proRefunds)
    .set({ status: to, updatedAt: input.now, ...input.set })
    .where(eq(proRefunds.id, row.id));
  await recordTransition(tx, {
    entityType: 'pro_refund',
    entityId: row.id,
    fromStatus: from,
    toStatus: to,
    cause: input.cause,
    traceId: activeTraceId(),
  });
  row.status = to;
}

const refundKey = (refundId: string) => `tipme-pro-refund-${refundId}`;

/** The partner call refunds need. */
export interface ProRefundProvider {
  refundPlatformCharge?(input: {
    chargeReference: string;
    amountMinor: bigint;
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    refundReference: string;
    status: 'processing' | 'paid' | 'failed';
  }>;
}

async function failRefund(
  tx: Tx,
  row: RefundRow,
  profileId: string,
  now: Date,
  cause: 'provider_event' | 'system',
): Promise<void> {
  await moveRefund(tx, row, 'FAILED', { now, cause });
  await enqueueOutbox(tx, {
    eventType: 'pro.refund_failed',
    aggregateId: row.id,
    payload: { purchaseId: row.purchaseId, profileId, refundId: row.id },
  });
}

/**
 * Sends approved refunds to the partner (with reconciliation, every run): each REQUESTED one once,
 * claimed before the call; one whose answer was lost (UNKNOWN) again with the same key, for 24
 * hours. A definite refusal fails it (Pro unchanged, a money issue). Its outcome comes by webhook.
 */
export async function sendProRefunds(
  db: Database,
  input: {
    provider: ProRefundProvider;
    providerName: string;
    now: Date;
    limit?: number;
  },
): Promise<{ sent: number; failed: number }> {
  const { now } = input;
  const refund = input.provider.refundPlatformCharge;
  if (!refund) return { sent: 0, failed: 0 };
  const rows = await db
    .select({ refund: proRefunds, purchase: proPurchases })
    .from(proRefunds)
    .innerJoin(proPurchases, eq(proPurchases.id, proRefunds.purchaseId))
    .where(
      and(
        eq(proPurchases.provider, input.providerName),
        or(
          and(eq(proRefunds.status, 'REQUESTED'), isNull(proRefunds.sentAt)),
          and(
            inArray(proRefunds.status, ['REQUESTED', 'UNKNOWN']),
            lte(proRefunds.sentAt, new Date(now.getTime() - RESEND_AFTER_MS)),
          ),
        ),
      ),
    )
    .orderBy(asc(proRefunds.createdAt))
    .limit(input.limit ?? 20);
  let sent = 0;
  let failed = 0;
  for (const { refund: row, purchase } of rows) {
    // Never past the partner's 24 hours for the same key: the webhook still settles it.
    if (
      row.sentAt &&
      now.getTime() - row.createdAt.getTime() > RESEND_WITHIN_MS
    )
      continue;
    if (!purchase.chargeReference) continue;
    // Claim the one call before making it.
    const claimed = await guarded(() =>
      db
        .update(proRefunds)
        .set({ sentAt: now })
        .where(
          and(
            eq(proRefunds.id, row.id),
            row.sentAt
              ? eq(proRefunds.sentAt, row.sentAt)
              : isNull(proRefunds.sentAt),
          ),
        )
        .returning({ id: proRefunds.id }),
    );
    if (claimed.length === 0) continue;
    let outcome:
      | { kind: 'answered'; refundReference: string; status: string }
      | { kind: 'refused' }
      | { kind: 'lost' };
    try {
      const answer = await refund.call(input.provider, {
        chargeReference: purchase.chargeReference,
        amountMinor: row.amountMinor,
        reference: refundKey(row.id),
        idempotencyKey: refundKey(row.id),
      });
      outcome = { kind: 'answered', ...answer };
    } catch (error) {
      outcome =
        error instanceof Error &&
        ['ProRefundRefusedError', 'BachsRequestNotSentError'].includes(
          error.name,
        )
          ? { kind: 'refused' }
          : { kind: 'lost' };
    }
    await guarded(() =>
      db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(proRefunds)
          .where(eq(proRefunds.id, row.id))
          .for('update');
        if (!locked) return;
        if (locked.status !== 'REQUESTED' && locked.status !== 'UNKNOWN')
          return;
        if (
          outcome.kind === 'refused' ||
          (outcome.kind === 'answered' && outcome.status === 'failed')
        ) {
          await failRefund(
            tx,
            locked,
            personOf(purchase.profileId),
            now,
            'system',
          );
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
  return { sent, failed };
}

/**
 * A refund event about a Pro purchase on TipMe's own account (`refund.created` / `paid` / `failed`).
 * Pending: noted. Paid: the reversal booked once and that month ended (also for a refund made on the
 * partner's dashboard, which has no TipMe row). Failed: Pro unchanged, a money issue.
 */
export async function applyProRefundEvent(
  db: Database,
  input: {
    purchaseId: string;
    eventRowId: string;
    refundState: 'pending' | 'paid' | 'failed';
    /** The partner's refund, as `refund.<id>`. */
    partnerRefundId: string | null;
    /** The reference TipMe sent (`tipme-pro-refund-<id>`), when the event repeats it. */
    operationReference: string | null;
    refundedMinor: bigint | null;
    refundFeeMinor: bigint | null;
    now: Date;
  },
): Promise<{
  outcome: 'noted' | 'refunded' | 'failed' | 'already';
  profileId: string;
  handleLower: string | null;
  planChanged: boolean;
}> {
  const { now } = input;
  const partnerRef = input.partnerRefundId?.startsWith('refund.')
    ? input.partnerRefundId.slice('refund.'.length)
    : null;
  return guarded(() =>
    db.transaction(async (tx) => {
      const purchase = await lockPurchase(tx, input.purchaseId);
      const result = (
        outcome: 'noted' | 'refunded' | 'failed' | 'already',
        planChanged = false,
        handleLower: string | null = null,
      ) => ({
        outcome,
        profileId: personOf(purchase.profileId),
        handleLower,
        planChanged,
      });
      const ours = /^tipme-pro-refund-([0-9a-f-]{36})$/.exec(
        input.operationReference ?? '',
      )?.[1];
      const candidates = await tx
        .select()
        .from(proRefunds)
        .where(eq(proRefunds.purchaseId, purchase.id))
        .orderBy(desc(proRefunds.createdAt))
        .for('update');
      const row =
        candidates.find((c) => ours && c.id === ours) ??
        candidates.find(
          (c) => partnerRef && c.providerRefundReference === partnerRef,
        ) ??
        candidates.find((c) => c.status !== 'FAILED' && c.status !== 'PAID') ??
        null;
      // A refund TipMe didn't ask for (made on the partner's dashboard): staff are told.
      if (!row && input.refundState !== 'failed')
        await enqueueOutbox(tx, {
          eventType: 'pro.reversed',
          aggregateId: purchase.id,
          dedupeSuffix: input.eventRowId,
          payload: {
            purchaseId: purchase.id,
            profileId: purchase.profileId,
            providerEventRowId: input.eventRowId,
          },
        });
      if (input.refundState === 'pending') {
        if (row && (row.status === 'REQUESTED' || row.status === 'UNKNOWN'))
          await moveRefund(tx, row, 'PROCESSING', {
            now,
            cause: 'provider_event',
            ...(partnerRef
              ? { set: { providerRefundReference: partnerRef } }
              : {}),
          });
        return result('noted');
      }
      if (input.refundState === 'failed') {
        if (!row || row.status === 'PAID' || row.status === 'FAILED')
          return result('already');
        await failRefund(
          tx,
          row,
          personOf(purchase.profileId),
          now,
          'provider_event',
        );
        return result('failed');
      }
      // Paid: final. Booked once per payment (the partner allows one refund per payment).
      const refunded =
        input.refundedMinor ?? row?.amountMinor ?? purchase.amountMinor;
      const fee = input.refundFeeMinor ?? 0n;
      const booked = await postLedgerTransaction(tx, {
        operationType: 'pro_refund',
        operationKey: `pro_refund.${purchase.id}`,
        currency: purchase.currency,
        proPurchaseId: purchase.id,
        lines: buildProRefundPosting({
          refundedMinor: refunded,
          refundFeeMinor: fee,
          grossMinor: purchase.amountMinor,
        }),
        traceId: activeTraceId(),
      });
      if (row && row.status !== 'PAID' && row.status !== 'FAILED')
        await moveRefund(tx, row, 'PAID', {
          now,
          cause: 'provider_event',
          set: {
            refundedMinor: refunded,
            refundFeeMinor: fee,
            ...(partnerRef ? { providerRefundReference: partnerRef } : {}),
          },
        });
      if (!booked.created) return result('already');
      const ended = await endPaidMonth(tx, purchase, now);
      return result('refunded', ended.planChanged, ended.handleLower);
    }),
  );
}

/** A page's paid Pro payments, newest first, with whether each can be refunded (for staff). */
export async function opsProPayments(
  db: Database,
  profileId: string,
  now: Date,
): Promise<(ProRefundFacts & { purchaseId: string; amountMinor: bigint })[]> {
  const rows = await guarded(() =>
    db
      .select({ id: proPurchases.id })
      .from(proPurchases)
      .where(
        and(
          eq(proPurchases.profileId, profileId),
          inArray(proPurchases.status, ['PAID']),
        ),
      )
      .orderBy(desc(proPurchases.paidAt))
      .limit(24),
  );
  const out: (ProRefundFacts & { purchaseId: string; amountMinor: bigint })[] =
    [];
  for (const row of rows) {
    const facts = await proRefundFacts(db, row.id, now);
    out.push({
      ...facts,
      purchaseId: row.id,
      amountMinor: facts.amountMinor ?? 0n,
    });
  }
  return out;
}
