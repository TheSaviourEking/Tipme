import {
  canTransition,
  TIP_REFUND_TRANSITIONS,
  tipRefundParts,
  type TipRefundStatus,
} from '@tipme/domain';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { profiles, tipRefunds, tips } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { openIssue } from './issues.js';
import { reverseTip } from './reversals.js';
import { recordTransition } from './transitions.js';

/*
 * Staff "Refund tip" (owner, 14 Nov 2026), behind TIP_REFUNDS (off by default). TipMe keeps its fee:
 * the supporter gets back the tip minus TipMe's fee on that tip's quote, which is exactly what its
 * recipients received. Staff ask and a second person approves (`tip.refund`, a serious action);
 * approving only records the refund (REQUESTED). The worker asks our payment partner once, as the
 * recipient's account, with the key `tipme-tip-refund-<id>` (the same key returns the same refund),
 * and only refund.paid books it: `reverseTip` under the refund rule, so the person and the business
 * each give back what they received and nothing of TipMe's fee moves. A refusal or refund.failed
 * moves nothing and tells staff; a failed refund doesn't count, so it can be asked again. Tips paid
 * by bank transfer can't be refunded by the partner (its refund guide).
 */

/** The partner answers the same key with the same refund; after 24 hours TipMe never resends. */
const RESEND_WITHIN_MS = 24 * 3_600_000;
const RESEND_AFTER_MS = 2 * 60_000;

export type TipRefundRefusal =
  'not_paid' | 'team' | 'already' | 'bank_transfer' | 'no_charge';

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
};

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
  const refusal: TipRefundRefusal | null =
    row.status !== 'SUCCEEDED'
      ? 'not_paid'
      : !row.profile_id
        ? 'team'
        : open || row.reversed
          ? 'already'
          : bankTransfer
            ? 'bank_transfer'
            : !row.provider || !row.provider_reference || netMinor <= 0n
              ? 'no_charge'
              : null;
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
  };
}

/**
 * The serious action's work (`tip.refund`): checks again under the tip's lock and records the
 * approved refund for the worker to send. Moves no money and books nothing.
 */
export async function askTipRefund(
  tx: Tx,
  input: {
    tipId: string;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ refundId: string; amountMinor: string }> {
  const [tip] = await tx
    .select({ id: tips.id })
    .from(tips)
    .where(eq(tips.id, input.tipId))
    .for('update');
  if (!tip) throw new OperationError('TIP_REFUND_REFUSED', 'not_paid');
  const facts = await tipRefundFacts(tx, input.tipId);
  if (!facts.refundable || !facts.provider || !facts.providerReference)
    throw new OperationError('TIP_REFUND_REFUSED', facts.refusal ?? 'not_paid');
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

async function failRefund(
  tx: Tx,
  row: RefundRow,
  failure: 'bank_transfer' | 'not_refundable' | 'refused' | 'partner_failed',
  now: Date,
  cause: 'provider_event' | 'system',
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
      failure === 'bank_transfer'
        ? 'It was paid by bank transfer, which our payment partner can’t refund.'
        : failure === 'partner_failed'
          ? 'Our payment partner reported the refund failed.'
          : 'Our payment partner refused it (for example, the account couldn’t fund it, or the payment was already refunded).',
  });
}

/** The partner call tip refunds need. */
export interface TipRefundProvider {
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
  if (!provider.refundAccountCharge) return { sent: 0, failed: 0 };
  const rows = await guarded(() =>
    db
      .select()
      .from(tipRefunds)
      .where(
        and(
          eq(tipRefunds.provider, input.providerName),
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
  return { sent, failed };
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
        await failRefund(tx, row, 'partner_failed', now, 'provider_event');
        return 'failed';
      }
      const refunded = input.refundedMinor ?? row.amountMinor;
      const fee = input.refundFeeMinor ?? 0n;
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
