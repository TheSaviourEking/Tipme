import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { buildProBalancePosting, lagosDateWords } from '@tipme/domain';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  paymentAccounts,
  payouts,
  proPurchases,
  withdrawalHolds,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { balanceIn } from './balance.js';
import { personOf } from './owner.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import type { MailSealing } from './mail-queue.js';
import { enqueueOutbox } from './outbox.js';
import { holdsOf } from './payouts.js';
import { startPaidPeriod } from './pro-periods.js';
import {
  lockPurchase,
  move,
  proIdempotencyKey,
  requestProPurchase,
  view,
  type ProPurchaseView,
} from './pro-purchases.js';

/*
 * Paying for Pro from the TipMe balance (plan Task 8; ruling 8), behind PRO_PAY_FROM_BALANCE (off
 * by default: the partner's policy answer is pending). The partner moves the person's AVAILABLE
 * balance to TipMe's own account (`POST /v1/transfers`, `destination: "self"`); only then is it
 * booked, once (`pro.<purchaseId>`). It can't be reversed, so it is never sent blindly twice: a lost
 * answer is read back from the account's transfers, never re-sent.
 *
 * What can be spent is the lower of what the ledger owes the person (less withdrawals in flight;
 * a business's share is never theirs) and what the partner holds on their account (less
 * withdrawals queued but not yet sent). The amount is reserved from the moment the purchase opens
 * (`balanceQuery` counts open balance purchases), under the profile lock withdrawals also take.
 */

/** The partner calls a balance payment needs (the payout port's). */
export interface ProCollectProvider {
  payoutCapability(accountRef: string): Promise<{ status: string }>;
  payoutBalance(
    accountRef: string,
    currency: 'NGN',
  ): Promise<{ availableMinor: bigint }>;
  collectToPlatform?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
  }): Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
  findPlatformCollection?(
    accountRef: string,
    idempotencyKey: string,
  ): Promise<{
    transferRef: string;
    status: 'paid' | 'pending';
    amountMinor: bigint;
    currency: string;
  } | null>;
}

/** No transfer found this long after a lost answer: nothing moved (as for payouts). */
const GIVE_UP_AFTER_MS = 30 * 60_000;
const STALE_AFTER_MS = 2 * 60_000;

/** The account the money comes from: the person's connected account, or (pretend) their page. */
async function accountOf(
  db: Database,
  profileId: string,
  adapterName: string,
): Promise<string | null> {
  const environment = bachsEnvironment(adapterName);
  if (!environment) return adapterName === 'mock' ? profileId : null;
  const [account] = await db
    .select({ reference: paymentAccounts.providerAccountReference })
    .from(paymentAccounts)
    .where(
      and(
        eq(paymentAccounts.profileId, profileId),
        eq(paymentAccounts.provider, recordedProviderName(adapterName)),
        eq(paymentAccounts.environment, environment),
      ),
    );
  return account?.reference ?? null;
}

/** Withdrawals queued for the worker but not yet sent: the partner's figure still includes them. */
async function queuedNotSent(tx: Tx, profileId: string): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${payouts.amountMinor}), 0)` })
    .from(payouts)
    .where(
      and(
        eq(payouts.profileId, profileId),
        eq(payouts.status, 'REQUESTED'),
        isNull(payouts.providerReference),
      ),
    );
  return BigInt(row?.total ?? 0);
}

/** A refusal that proves no money moved. */
function definitelyNotMoved(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'PayoutRejectedError',
    'PlatformRefusalError',
    'BachsRequestNotSentError',
  ].includes(error.name);
}

/**
 * Books a balance payment the partner confirmed moved, once, under the purchase's lock: PAID, the
 * month, the `pro.<id>` posting and the receipt. A transfer of another amount goes to REVIEW.
 */
async function settleCollection(
  db: Database,
  input: {
    purchaseId: string;
    transfer: { transferRef: string; amountMinor: bigint; currency: string };
    sealing: MailSealing;
    now: Date;
  },
): Promise<{
  outcome: 'paid' | 'already' | 'review';
  profileId: string;
  handleLower: string | null;
  planChanged: boolean;
}> {
  const { now } = input;
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, input.purchaseId);
      const done = (
        outcome: 'paid' | 'already' | 'review',
        planChanged = false,
        handleLower: string | null = null,
      ) => ({
        outcome,
        profileId: personOf(row.profileId),
        handleLower,
        planChanged,
      });
      if (row.status !== 'COLLECTING' && row.status !== 'UNKNOWN')
        return done('already');
      if (
        input.transfer.amountMinor !== row.amountMinor ||
        input.transfer.currency !== row.currency
      ) {
        await move(tx, row, 'REVIEW', {
          now,
          cause: 'system',
          set: { providerReference: input.transfer.transferRef },
        });
        await enqueueOutbox(tx, {
          eventType: 'pro.amount_mismatch',
          aggregateId: row.id,
          payload: { purchaseId: row.id, profileId: row.profileId },
        });
        return done('review');
      }
      let period: Awaited<ReturnType<typeof startPaidPeriod>>;
      try {
        period = await tx.transaction((savepoint) =>
          startPaidPeriod(savepoint, {
            profileId: personOf(row.profileId),
            purchaseId: row.id,
            paidBy: 'balance',
            amountMinor: row.amountMinor,
            currency: 'NGN',
            now,
          }),
        );
      } catch (error) {
        if (
          error instanceof OperationError &&
          error.code === 'PRO_ALREADY_RENEWED'
        ) {
          await move(tx, row, 'REVIEW', { now, cause: 'system' });
          await enqueueOutbox(tx, {
            eventType: 'pro.conflict',
            aggregateId: row.id,
            payload: { purchaseId: row.id, profileId: row.profileId },
          });
          return done('review');
        }
        throw error;
      }
      await move(tx, row, 'PAID', {
        now,
        cause: 'system',
        set: {
          paidAt: now,
          feeMinor: 0n,
          providerReference: input.transfer.transferRef,
        },
      });
      await postLedgerTransaction(tx, {
        operationType: 'pro_sale',
        operationKey: `pro.${row.id}`,
        currency: row.currency,
        proPurchaseId: row.id,
        lines: buildProBalancePosting({
          amountMinor: row.amountMinor,
          profileId: personOf(row.profileId),
        }),
        traceId: activeTraceId(),
      });
      await mailOwner(tx, input.sealing, {
        profileId: personOf(row.profileId),
        type: 'pro_receipt',
        data: {
          amountMinor: String(row.amountMinor),
          paidBy: 'balance',
          startDate: lagosDateWords(period.startsAt),
          endDate: lagosDateWords(period.endsAt),
          purchaseRef: row.id.replaceAll('-', '').slice(-8),
        },
        dedupeKey: `pro_receipt.${row.id}`,
        now,
      });
      return done('paid', period.planChanged, period.handleLower);
    }),
  );
}

/** A collect that definitely moved nothing: FAILED, which releases the reservation. */
async function failCollection(
  db: Database,
  purchaseId: string,
  now: Date,
  alert: boolean,
): Promise<void> {
  await guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, purchaseId);
      if (row.status !== 'COLLECTING' && row.status !== 'UNKNOWN') return;
      await move(tx, row, 'FAILED', { now, cause: 'system' });
      if (alert)
        await enqueueOutbox(tx, {
          eventType: 'pro.collect_unknown',
          aggregateId: row.id,
          payload: { purchaseId: row.id, profileId: row.profileId },
        });
    }),
  );
}

async function markCollect(
  db: Database,
  purchaseId: string,
  now: Date,
  to: 'UNKNOWN' | null,
  transferRef?: string,
): Promise<void> {
  await guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, purchaseId);
      await tx
        .update(proPurchases)
        .set({
          lastCheckedAt: now,
          ...(transferRef ? { providerReference: transferRef } : {}),
        })
        .where(eq(proPurchases.id, row.id));
      if (to && row.status === 'COLLECTING')
        await move(tx, row, to, { now, cause: 'system' });
    }),
  );
}

/**
 * Buys a month from the balance: checks what can be spent (partner read first, outside the
 * transaction; then the profile lock, holds and the ledger), opens a COLLECTING purchase that
 * reserves the amount, then asks the partner to move it, once, with `tipme-pro-<purchaseId>`.
 * Paid: booked at once. A definite refusal: FAILED, released, PRO_BALANCE_REFUSED. No answer:
 * UNKNOWN, still reserved, for the read-back. The same Idempotency-Key returns the same purchase.
 */
export async function buyProFromBalance(
  db: Database,
  input: {
    profileId: string;
    expectedAmountMinor: bigint;
    idempotencyKey: string;
    provider: ProCollectProvider;
    /** The adapter's name ('mock', 'bachs-sandbox', 'bachs-live'); rows record 'mock' or 'bachs'. */
    providerName: string;
    sealing: MailSealing;
    now: Date;
  },
): Promise<ProPurchaseView & { replayed: boolean }> {
  const { now } = input;
  const recorded = recordedProviderName(input.providerName);
  // A retry gets its purchase even when the partner is down.
  const [earlier] = await guarded(() =>
    db
      .select()
      .from(proPurchases)
      .where(
        and(
          eq(proPurchases.profileId, input.profileId),
          eq(proPurchases.idempotencyKey, input.idempotencyKey),
        ),
      ),
  );
  if (earlier) {
    const { purchase } = await requestProPurchase(db, {
      subject: { profileId: input.profileId },
      method: 'balance',
      expectedAmountMinor: input.expectedAmountMinor,
      idempotencyKey: input.idempotencyKey,
      now,
    });
    return { ...view(purchase), replayed: true };
  }
  const collect = input.provider.collectToPlatform;
  if (!collect) throw new OperationError('PRO_CHECKOUT_UNAVAILABLE');
  const accountRef = await guarded(() =>
    accountOf(db, input.profileId, input.providerName),
  );
  if (!accountRef) throw new OperationError('PAYOUT_SETUP_NEEDED');
  let partnerMinor: bigint;
  try {
    const capability = await input.provider.payoutCapability(accountRef);
    if (capability.status !== 'active')
      throw new OperationError('PAYOUT_SETUP_NEEDED');
    partnerMinor = (await input.provider.payoutBalance(accountRef, 'NGN'))
      .availableMinor;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('PAYOUT_PROVIDER_UNAVAILABLE');
  }
  const { purchase, replayed } = await requestProPurchase(db, {
    subject: { profileId: input.profileId },
    method: 'balance',
    expectedAmountMinor: input.expectedAmountMinor,
    idempotencyKey: input.idempotencyKey,
    status: 'COLLECTING',
    extra: { accountReference: accountRef, provider: recorded },
    now,
    guard: async (tx, price) => {
      const [hold] = await tx
        .select({ id: withdrawalHolds.id })
        .from(withdrawalHolds)
        .where(
          and(
            holdsOf({ profileId: input.profileId }),
            isNull(withdrawalHolds.releasedAt),
          ),
        )
        .limit(1);
      if (hold) throw new OperationError('WITHDRAWALS_PAUSED');
      const ledger = (await balanceIn(tx, input.profileId)).availableMinor;
      if (ledger < 0n) throw new OperationError('BALANCE_BELOW_ZERO');
      const partner = partnerMinor - (await queuedNotSent(tx, input.profileId));
      const spendable = ledger < partner ? ledger : partner;
      if (price.amountMinor > spendable)
        throw new OperationError('INSUFFICIENT_BALANCE');
    },
  });
  if (replayed) return { ...view(purchase), replayed: true };
  let answer: { transferRef: string; status: 'paid' | 'pending' };
  try {
    answer = await collect.call(input.provider, {
      accountRef,
      amountMinor: purchase.amountMinor,
      currency: 'NGN',
      idempotencyKey: proIdempotencyKey(purchase.id),
    });
  } catch (error) {
    if (definitelyNotMoved(error)) {
      await failCollection(db, purchase.id, now, false);
      throw new OperationError('PRO_BALANCE_REFUSED');
    }
    // It may have moved: never asked again, only read back.
    await markCollect(db, purchase.id, now, 'UNKNOWN');
    return { ...(await current(db, purchase.id)), replayed: false };
  }
  if (answer.status === 'paid')
    await settleCollection(db, {
      purchaseId: purchase.id,
      transfer: {
        transferRef: answer.transferRef,
        amountMinor: purchase.amountMinor,
        currency: 'NGN',
      },
      sealing: input.sealing,
      now,
    });
  else await markCollect(db, purchase.id, now, null, answer.transferRef);
  return { ...(await current(db, purchase.id)), replayed: false };
}

async function current(db: Database, purchaseId: string) {
  const [row] = await db
    .select()
    .from(proPurchases)
    .where(eq(proPurchases.id, purchaseId));
  return view(row!);
}

/**
 * The read-back for balance payments (with reconciliation, every run): each one still COLLECTING
 * or UNKNOWN after two minutes is looked for among the account's transfers by its key. Paid: booked
 * once. Pending: asked again later. Not there 30 minutes on: nothing moved, so it is FAILED and the
 * reservation released, with a `pro.collect_unknown` alert for staff to check the partner. Never
 * sent again.
 */
export async function reconcileProCollections(
  db: Database,
  input: {
    provider: Pick<ProCollectProvider, 'findPlatformCollection'>;
    providerName: string;
    now: Date;
    sealing: MailSealing;
    minAgeMs?: number;
    limit?: number;
  },
): Promise<{
  paid: {
    profileId: string;
    handleLower: string | null;
    planChanged: boolean;
  }[];
  checked: number;
  failed: number;
}> {
  const { now } = input;
  const find = input.provider.findPlatformCollection;
  const paid: {
    profileId: string;
    handleLower: string | null;
    planChanged: boolean;
  }[] = [];
  if (!find) return { paid, checked: 0, failed: 0 };
  const before = new Date(now.getTime() - (input.minAgeMs ?? STALE_AFTER_MS));
  const rows = await db
    .select()
    .from(proPurchases)
    .where(
      and(
        eq(proPurchases.method, 'balance'),
        inArray(proPurchases.status, ['COLLECTING', 'UNKNOWN']),
        eq(proPurchases.provider, recordedProviderName(input.providerName)),
        lte(proPurchases.createdAt, before),
        or(
          isNull(proPurchases.lastCheckedAt),
          lte(proPurchases.lastCheckedAt, before),
        ),
      ),
    )
    .orderBy(asc(proPurchases.createdAt))
    .limit(input.limit ?? 50);
  let failed = 0;
  for (const row of rows) {
    try {
      if (!row.accountReference) continue;
      const found = await find.call(
        input.provider,
        row.accountReference,
        proIdempotencyKey(row.id),
      );
      if (found?.status === 'paid') {
        const result = await settleCollection(db, {
          purchaseId: row.id,
          transfer: found,
          sealing: input.sealing,
          now,
        });
        if (result.outcome === 'paid') paid.push(result);
        continue;
      }
      if (
        !found &&
        now.getTime() - row.createdAt.getTime() >= GIVE_UP_AFTER_MS
      ) {
        await failCollection(db, row.id, now, true);
        continue;
      }
      await markCollect(
        db,
        row.id,
        now,
        null,
        found ? found.transferRef : undefined,
      );
    } catch {
      // One purchase's trouble never stops the others; it is read back again next run.
      failed += 1;
    }
  }
  return { paid, checked: rows.length, failed };
}
