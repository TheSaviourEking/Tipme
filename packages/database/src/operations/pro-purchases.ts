import { createHash } from 'node:crypto';
import {
  buildProCheckoutPosting,
  canTransition,
  lagosDateWords,
  PRO_PURCHASE_TRANSITIONS,
  type ProPurchaseStatus,
} from '@tipme/domain';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  proPeriods,
  proPurchases,
  profiles,
  providerEvents,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { type MoneyOwner, ownerColumns, personOf } from './owner.js';
import type { MailSealing } from './mail-queue.js';
import { enqueueOutbox } from './outbox.js';
import {
  type ProPaidBy,
  recomputePlan,
  startBusinessPaidPeriod,
  startPaidPeriod,
} from './pro-periods.js';
import { recordSavedCardIn, renewalFailedIn } from './pro-auto-renew.js';
import { currentProPrice } from './pro-price.js';
import { jsonSafe } from './provider-events.js';
import { recordTransition } from './transitions.js';

/*
 * Paid Pro purchases by checkout on TipMe's own partner account (ADR-0015). The server is the only
 * source of the price; the client's expected amount only refuses a mismatch. A purchase is PAID
 * only from the partner's read-back (a signed webhook triggers it; a redirect never does), booked
 * once (`pro.<purchaseId>`) and starts one month once (`pro_periods.purchase_id` is unique).
 */

/** What reading the payment back from the partner said. The authority, never the webhook. */
export interface ProVerified {
  status: 'succeeded' | 'failed' | 'pending' | 'not_found';
  amountMinor: bigint;
  currency: string;
  feeMinor: bigint;
  /** Taken, but its evidence (the fee) isn't final yet: never expire it. */
  collected?: true;
  method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER';
  /** The partner's payment (charge) id: what a refund names (plan Task 9). */
  chargeReference?: string;
  /** Pretend provider only: the card saved while paying (the partner says so by webhook). */
  savedMethod?: { customerReference: string; paymentMethodReference: string };
}

/** The provider calls a purchase needs. The database package never imports an adapter. */
export interface ProCheckoutProvider {
  initializePlatformCheckout?(input: {
    purchaseId: string;
    amountMinor: bigint;
    currency: 'NGN';
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    saveCard?: { customerReference: string };
  }): Promise<{
    providerReference: string;
    checkoutUrl: string;
    expiresAt: Date;
  }>;
  verifyTransaction(providerReference: string): Promise<ProVerified>;
}

export type ProPurchaseMethod = 'card' | 'balance' | 'saved_card';

export interface ProPurchaseView {
  purchaseId: string;
  status: ProPurchaseStatus;
  amountMinor: bigint;
  currency: 'NGN';
  checkoutUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
}

export type PurchaseRow = typeof proPurchases.$inferSelect;

export const view = (row: PurchaseRow): ProPurchaseView => ({
  purchaseId: row.id,
  status: row.status as ProPurchaseStatus,
  amountMinor: row.amountMinor,
  currency: 'NGN',
  // Only an open purchase can be resumed on the partner's page.
  checkoutUrl: row.status === 'PENDING' ? row.checkoutUrl : null,
  expiresAt: row.expiresAt,
  paidAt: row.paidAt,
});

/** The partner's idempotency key: one checkout per purchase, however often it is asked. */
export const proIdempotencyKey = (purchaseId: string) =>
  `tipme-pro-${purchaseId}`;

/** A definite refusal by name (the adapter's classes are not imported here). */
export function definitelyRefused(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.name === 'PlatformCheckoutUnavailableError') return 'unavailable';
  if (error.name === 'BachsRequestNotSentError') return 'not_sent';
  const status = (error as unknown as { statusCode?: unknown }).statusCode;
  if (
    error.name === 'BachsApiError' &&
    typeof status === 'number' &&
    status < 500
  )
    return 'refused';
  return null;
}

export async function move(
  tx: Tx,
  row: PurchaseRow,
  to: ProPurchaseStatus,
  input: {
    now: Date;
    cause: 'provider_event' | 'system' | 'expiry';
    providerEventId?: string;
    set?: Partial<typeof proPurchases.$inferInsert>;
  },
): Promise<void> {
  const from = row.status as ProPurchaseStatus;
  if (!canTransition(PRO_PURCHASE_TRANSITIONS, from, to))
    throw new OperationError('INVALID_INPUT');
  await tx
    .update(proPurchases)
    .set({ status: to, updatedAt: input.now, ...input.set })
    .where(eq(proPurchases.id, row.id));
  await recordTransition(tx, {
    entityType: 'pro_purchase',
    entityId: row.id,
    fromStatus: from,
    toStatus: to,
    cause: input.cause,
    ...(input.providerEventId
      ? { providerEventId: input.providerEventId }
      : {}),
    traceId: activeTraceId(),
  });
  row.status = to;
}

export async function lockPurchase(
  tx: Tx,
  purchaseId: string,
): Promise<PurchaseRow> {
  const [row] = await tx
    .select()
    .from(proPurchases)
    .where(eq(proPurchases.id, purchaseId))
    .for('update');
  if (!row) throw new OperationError('PRO_PURCHASE_NOT_FOUND');
  return row;
}

/**
 * Opens a purchase at the server's price, under the subject's lock (the page's, or for Business Pro
 * the business's): refused when the client's expected amount differs (PRO_PRICE_CHANGED), a month
 * is already queued (PRO_ALREADY_RENEWED) or another purchase is open (PRO_PURCHASE_OPEN). A
 * business must be verified (BUSINESS_NOT_VERIFIED, ruling R11), is priced from the business plan
 * and names the owner who pays (`boughtBy`). The same Idempotency-Key returns the same purchase.
 * Claims the purchase's one partner create call (`start_claimed_at`) in the same transaction.
 */
export function requestProPurchase(
  db: Database,
  input: {
    subject: MoneyOwner;
    /** The owner paying for a business (required for one, never for a page). */
    boughtBy?: string;
    method: ProPurchaseMethod;
    expectedAmountMinor: bigint;
    idempotencyKey: string;
    now: Date;
    /** The first status: PENDING for a checkout, COLLECTING for money moved by TipMe. */
    status?: 'PENDING' | 'COLLECTING';
    /** Columns this way of paying records (the account, the opt-in, the month renewed). */
    extra?: Partial<
      Pick<
        typeof proPurchases.$inferInsert,
        'accountReference' | 'saveCard' | 'renewsPeriodId' | 'provider'
      >
    >;
    /** More checks under the subject's lock, after the price and open checks (the balance's). */
    guard?: (tx: Tx, price: { amountMinor: bigint }) => Promise<void>;
  },
): Promise<{ purchase: PurchaseRow; replayed: boolean }> {
  const { subject } = input;
  const isBusiness = 'businessId' in subject;
  if (!/^[\w.:-]{8,200}$/.test(input.idempotencyKey))
    return Promise.reject(new OperationError('INVALID_INPUT'));
  if (isBusiness !== (input.boughtBy !== undefined))
    return Promise.reject(new OperationError('INVALID_INPUT'));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        // A page's fingerprint is unchanged from before Business Pro.
        isBusiness ? `business:${subject.businessId}` : subject.profileId,
        input.method,
        String(input.expectedAmountMinor),
      ]),
    )
    .digest('hex');
  const ofSubject = isBusiness
    ? eq(proPurchases.businessId, subject.businessId)
    : eq(proPurchases.profileId, subject.profileId);
  return guarded(() =>
    db.transaction(async (tx) => {
      if (isBusiness) {
        const [business] = await tx
          .select({ id: businesses.id, status: businesses.status })
          .from(businesses)
          .where(eq(businesses.id, subject.businessId))
          .for('update');
        if (!business) throw new OperationError('BUSINESS_NOT_FOUND');
        if (business.status !== 'verified')
          throw new OperationError('BUSINESS_NOT_VERIFIED');
      } else {
        const [page] = await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.id, subject.profileId))
          .for('update');
        if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      }
      const [existing] = await tx
        .select()
        .from(proPurchases)
        .where(
          and(ofSubject, eq(proPurchases.idempotencyKey, input.idempotencyKey)),
        );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new OperationError('IDEMPOTENCY_CONFLICT');
        return { purchase: existing, replayed: true };
      }
      const price = await currentProPrice(
        tx,
        input.now,
        isBusiness ? 'business' : 'personal',
      );
      if (!price) throw new OperationError('PRO_PRICE_NOT_SET');
      if (price.amountMinor !== input.expectedAmountMinor)
        throw new OperationError('PRO_PRICE_CHANGED');
      const [queued] = await tx
        .select({ id: proPeriods.id })
        .from(proPeriods)
        .where(
          and(
            isBusiness
              ? eq(proPeriods.businessId, subject.businessId)
              : eq(proPeriods.profileId, subject.profileId),
            eq(proPeriods.status, 'SCHEDULED'),
          ),
        );
      if (queued) throw new OperationError('PRO_ALREADY_RENEWED');
      const [open] = await tx
        .select({ id: proPurchases.id })
        .from(proPurchases)
        .where(
          and(
            ofSubject,
            inArray(proPurchases.status, ['PENDING', 'COLLECTING', 'UNKNOWN']),
          ),
        );
      if (open) throw new OperationError('PRO_PURCHASE_OPEN');
      if (input.guard) await input.guard(tx, price);
      const id = newId();
      const status = input.status ?? 'PENDING';
      const [purchase] = await tx
        .insert(proPurchases)
        .values({
          id,
          ...ownerColumns(subject),
          boughtBy: input.boughtBy ?? null,
          method: input.method,
          priceId: price.id,
          amountMinor: price.amountMinor,
          currency: 'NGN',
          status,
          idempotencyKey: input.idempotencyKey,
          fingerprint,
          startClaimedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
          ...input.extra,
        })
        .returning();
      await recordTransition(tx, {
        entityType: 'pro_purchase',
        entityId: id,
        fromStatus: null,
        toStatus: status,
        cause: 'system',
        traceId: activeTraceId(),
      });
      return { purchase: purchase!, replayed: false };
    }),
  );
}

/** Records the checkout the partner made (or, after a lost answer, found again). */
async function attachCheckout(
  db: Database,
  input: {
    purchaseId: string;
    providerName: string;
    created: {
      providerReference: string;
      checkoutUrl: string;
      expiresAt: Date;
    };
    now: Date;
  },
): Promise<PurchaseRow> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, input.purchaseId);
      if (
        row.providerReference &&
        row.providerReference !== input.created.providerReference
      )
        throw new OperationError('INVALID_INPUT');
      await tx
        .update(proPurchases)
        .set({
          provider: input.providerName,
          providerReference: input.created.providerReference,
          checkoutUrl: input.created.checkoutUrl,
          expiresAt: input.created.expiresAt,
          updatedAt: input.now,
        })
        .where(eq(proPurchases.id, row.id));
      if (row.status === 'UNKNOWN')
        await move(tx, row, 'PENDING', { now: input.now, cause: 'system' });
      return {
        ...row,
        ...{
          provider: input.providerName,
          providerReference: input.created.providerReference,
          checkoutUrl: input.created.checkoutUrl,
          expiresAt: input.created.expiresAt,
        },
      };
    }),
  );
}

async function markStart(
  db: Database,
  purchaseId: string,
  to: 'FAILED' | 'UNKNOWN',
  providerName: string,
  now: Date,
): Promise<void> {
  await guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, purchaseId);
      await tx
        .update(proPurchases)
        .set({ provider: providerName })
        .where(eq(proPurchases.id, row.id));
      if (row.status === 'PENDING')
        await move(tx, row, to, { now, cause: 'system' });
    }),
  );
}

/**
 * Buys a month by checkout: opens the purchase, then asks the partner for a checkout on TipMe's own
 * account, once. A definite refusal fails the purchase (PRO_CHECKOUT_UNAVAILABLE: nothing was
 * charged); a lost answer leaves it UNKNOWN for reconciliation, which asks again with the same
 * idempotency key (creating a checkout moves no money, and the partner returns the same one).
 */
export async function buyProByCheckout(
  db: Database,
  input: {
    profileId: string;
    expectedAmountMinor: bigint;
    idempotencyKey: string;
    provider: ProCheckoutProvider;
    providerName: string;
    successUrl: string;
    cancelUrl: string;
    /** Auto-renew opt-in (plan Task 10): save the card on this customer while paying. */
    saveCard?: { customerReference: string };
    now: Date;
  },
): Promise<ProPurchaseView & { replayed: boolean }> {
  const { purchase, replayed } = await requestProPurchase(db, {
    subject: { profileId: input.profileId },
    method: 'card',
    expectedAmountMinor: input.expectedAmountMinor,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
    ...(input.saveCard ? { extra: { saveCard: true } } : {}),
  });
  if (replayed) return { ...view(purchase), replayed: true };
  const create = input.provider.initializePlatformCheckout;
  if (!create) {
    await markStart(db, purchase.id, 'FAILED', input.providerName, input.now);
    throw new OperationError('PRO_CHECKOUT_UNAVAILABLE');
  }
  let created: Awaited<
    ReturnType<NonNullable<ProCheckoutProvider['initializePlatformCheckout']>>
  >;
  try {
    created = await create.call(input.provider, {
      purchaseId: purchase.id,
      amountMinor: purchase.amountMinor,
      currency: 'NGN',
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: proIdempotencyKey(purchase.id),
      ...(input.saveCard ? { saveCard: input.saveCard } : {}),
    });
  } catch (error) {
    if (definitelyRefused(error)) {
      await markStart(db, purchase.id, 'FAILED', input.providerName, input.now);
      throw new OperationError('PRO_CHECKOUT_UNAVAILABLE');
    }
    // Anything else may have reached the partner: never asked again blindly here.
    await markStart(db, purchase.id, 'UNKNOWN', input.providerName, input.now);
    const [row] = await db
      .select()
      .from(proPurchases)
      .where(eq(proPurchases.id, purchase.id));
    return { ...view(row!), replayed: false };
  }
  const row = await attachCheckout(db, {
    purchaseId: purchase.id,
    providerName: input.providerName,
    created,
    now: input.now,
  });
  return { ...view(row), replayed: false };
}

/** One purchase for its owner, or null. */
export async function myProPurchase(
  db: Database,
  input: { profileId: string; purchaseId: string },
): Promise<ProPurchaseView | null> {
  const [row] = await db
    .select()
    .from(proPurchases)
    .where(
      and(
        eq(proPurchases.id, input.purchaseId),
        eq(proPurchases.profileId, input.profileId),
      ),
    );
  return row ? view(row) : null;
}

/** The page's open purchase, if any (to resume it). */
export async function openProPurchase(
  db: Database,
  profileId: string,
): Promise<ProPurchaseView | null> {
  const [row] = await db
    .select()
    .from(proPurchases)
    .where(
      and(
        eq(proPurchases.profileId, profileId),
        inArray(proPurchases.status, ['PENDING', 'COLLECTING', 'UNKNOWN']),
      ),
    );
  return row ? view(row) : null;
}

/** Finds the purchase an own-account event is about, by the reference TipMe recorded. */
export async function findProPurchaseByReference(
  db: Database,
  input: {
    provider: string;
    providerReference: string | null;
    operationReference: string | null;
    /** The partner's payment id (a refund's event names only the charge). */
    chargeReference?: string | null;
  },
): Promise<string | null> {
  if (input.chargeReference) {
    const [row] = await db
      .select({ id: proPurchases.id })
      .from(proPurchases)
      .where(
        and(
          eq(proPurchases.provider, input.provider),
          eq(proPurchases.chargeReference, input.chargeReference),
        ),
      );
    if (row) return row.id;
  }
  if (input.providerReference) {
    const [row] = await db
      .select({ id: proPurchases.id })
      .from(proPurchases)
      .where(
        and(
          eq(proPurchases.provider, input.provider),
          eq(proPurchases.providerReference, input.providerReference),
        ),
      );
    if (row) return row.id;
  }
  // A lost create answer: the event names the purchase as its reference, and TipMe has no
  // checkout id yet. Only then, and only for this provider.
  if (
    input.operationReference &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.operationReference,
    )
  ) {
    const [row] = await db
      .select({ id: proPurchases.id })
      .from(proPurchases)
      .where(
        and(
          eq(proPurchases.id, input.operationReference),
          eq(proPurchases.provider, input.provider),
          isNull(proPurchases.providerReference),
        ),
      );
    if (row) return row.id;
  }
  return null;
}

/** Stores a verified own-account event against its purchase, once per partner event id. */
export async function recordProEvent(
  db: Database,
  input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    purchaseId: string;
    payload: unknown;
  },
): Promise<{ eventRowId: string; duplicate: boolean }> {
  const payload = jsonSafe(input.payload);
  const id = newId();
  const inserted = await db
    .insert(providerEvents)
    .values({
      id,
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      signatureVerified: true,
      payloadHash: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
      payload,
      proPurchaseId: input.purchaseId,
    })
    .onConflictDoNothing({
      target: [providerEvents.provider, providerEvents.providerEventId],
    })
    .returning({ id: providerEvents.id });
  if (inserted[0]) return { eventRowId: inserted[0].id, duplicate: false };
  const [original] = await db
    .select({ id: providerEvents.id })
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.provider, input.provider),
        eq(providerEvents.providerEventId, input.providerEventId),
      ),
    );
  return { eventRowId: original?.id ?? id, duplicate: true };
}

export type ProConfirmOutcome =
  'paid' | 'already' | 'pending' | 'failed' | 'review';

/**
 * Applies the partner's read-back to a purchase, under its lock then the profile's. Succeeded with
 * the purchase's amount and currency: PAID, the `pro.<id>` posting, the month (from the old end
 * while one runs or is in grace, else now), the receipt. A purchase already EXPIRED or FAILED is
 * still credited (a late bank transfer), with the `pro.late_payment` alert. Any other amount or
 * currency, or a fee out of range: REVIEW with a money issue, nothing booked. Failed: EXPIRED once
 * the checkout's time is up, else FAILED. Pending: nothing changes.
 */
export async function confirmProCheckout(
  db: Database,
  input: {
    purchaseId: string;
    verified: ProVerified;
    now: Date;
    sealing: MailSealing;
    providerEventRowId?: string;
  },
): Promise<{
  outcome: ProConfirmOutcome;
  planChanged: boolean;
  /** The page whose purchase it was, or null for a business's (then `businessId`). */
  profileId: string | null;
  businessId: string | null;
  handleLower: string | null;
}> {
  const { verified, now } = input;
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, input.purchaseId);
      const done = (
        outcome: ProConfirmOutcome,
        planChanged = false,
        handleLower: string | null = null,
      ) => ({
        outcome,
        planChanged,
        profileId: row.profileId,
        businessId: row.businessId,
        handleLower,
      });
      const cause = input.providerEventRowId ? 'provider_event' : 'system';
      const event = input.providerEventRowId
        ? { providerEventId: input.providerEventRowId }
        : {};
      await tx
        .update(proPurchases)
        .set({ lastCheckedAt: now })
        .where(eq(proPurchases.id, row.id));
      if (row.status === 'PAID') {
        if (verified.status === 'failed')
          await enqueueOutbox(tx, {
            eventType: 'pro.conflict',
            aggregateId: row.id,
            dedupeSuffix: input.providerEventRowId ?? 'read',
            payload: { purchaseId: row.id, profileId: row.profileId },
          });
        return done('already');
      }
      if (row.status === 'REVIEW') return done('review');
      if (verified.status === 'pending' || verified.status === 'not_found') {
        // Not found right after creation is not proof of anything: reconciliation keeps asking.
        return done('pending');
      }
      if (verified.status === 'failed') {
        if (
          row.status === 'PENDING' ||
          row.status === 'UNKNOWN' ||
          row.status === 'COLLECTING'
        ) {
          const ended =
            row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
          await move(tx, row, ended ? 'EXPIRED' : 'FAILED', {
            now,
            cause,
            ...event,
          });
          // An automatic renewal refused: the normal reminders and grace take over.
          if (row.method === 'saved_card' && row.profileId !== null)
            await renewalFailedIn(tx, input.sealing, row, now);
        }
        return done('failed');
      }
      // Succeeded: the money was taken. Only an exact match is booked.
      if (
        verified.amountMinor !== row.amountMinor ||
        verified.currency !== row.currency ||
        verified.feeMinor < 0n ||
        verified.feeMinor > verified.amountMinor
      ) {
        await move(tx, row, 'REVIEW', { now, cause, ...event });
        await enqueueOutbox(tx, {
          eventType: 'pro.amount_mismatch',
          aggregateId: row.id,
          dedupeSuffix: input.providerEventRowId ?? 'read',
          payload: { purchaseId: row.id, profileId: row.profileId },
        });
        return done('review');
      }
      const late = row.status === 'EXPIRED' || row.status === 'FAILED';
      const paidBy: ProPaidBy =
        row.method === 'saved_card'
          ? 'saved_card'
          : verified.method === 'NGN_BANK_TRANSFER'
            ? 'bank_transfer'
            : 'card';
      let period: {
        startsAt: Date;
        endsAt: Date;
        planChanged: boolean;
        handleLower: string | null;
      };
      const start = {
        purchaseId: row.id,
        paidBy,
        amountMinor: row.amountMinor,
        currency: 'NGN' as const,
        now,
      };
      try {
        // A business's month (Business Pro) takes the business lock, never a page's.
        const businessId = row.businessId;
        period = await tx.transaction((savepoint) =>
          businessId !== null
            ? startBusinessPaidPeriod(savepoint, { ...start, businessId }).then(
                (started) => ({ ...started, handleLower: null }),
              )
            : startPaidPeriod(savepoint, {
                ...start,
                profileId: personOf(row.profileId),
              }),
        );
      } catch (error) {
        // A month already queued meanwhile (a late payment after another purchase): the money is
        // taken but there is nowhere to put it. Staff decide; nothing is booked.
        if (
          error instanceof OperationError &&
          error.code === 'PRO_ALREADY_RENEWED'
        ) {
          await move(tx, row, 'REVIEW', { now, cause, ...event });
          await enqueueOutbox(tx, {
            eventType: 'pro.conflict',
            aggregateId: row.id,
            dedupeSuffix: input.providerEventRowId ?? 'read',
            payload: { purchaseId: row.id, profileId: row.profileId },
          });
          return done('review');
        }
        throw error;
      }
      await move(tx, row, 'PAID', {
        now,
        cause,
        ...event,
        set: {
          paidAt: now,
          feeMinor: verified.feeMinor,
          ...(verified.chargeReference
            ? { chargeReference: verified.chargeReference }
            : {}),
        },
      });
      // The pretend partner reports a card saved while paying here; the real one by webhook.
      if (row.saveCard && verified.savedMethod && row.profileId !== null)
        await recordSavedCardIn(tx, {
          provider: row.provider ?? '',
          ...verified.savedMethod,
          now,
        });
      await postLedgerTransaction(tx, {
        operationType: 'pro_sale',
        operationKey: `pro.${row.id}`,
        currency: row.currency,
        proPurchaseId: row.id,
        lines: buildProCheckoutPosting({
          grossMinor: row.amountMinor,
          feeMinor: verified.feeMinor,
        }),
        traceId: activeTraceId(),
      });
      if (late)
        await enqueueOutbox(tx, {
          eventType: 'pro.late_payment',
          aggregateId: row.id,
          payload: { purchaseId: row.id, profileId: row.profileId },
        });
      // A business's receipt goes to the owner who paid with Phase B's mail (Task B4).
      if (row.profileId !== null)
        await mailOwner(tx, input.sealing, {
          profileId: row.profileId,
          type: 'pro_receipt',
          data: {
            amountMinor: String(row.amountMinor),
            paidBy,
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

const STALE_AFTER_MS = 2 * 60_000;

/**
 * Reconciliation (with the tips', every run): asks the partner about every open purchase older than
 * two minutes. A purchase whose create answer was lost is asked again with the same idempotency
 * key first (the partner returns the same checkout; no money moves by creating one). A partner
 * that says failed after the checkout's time expires it, so a new one can start.
 */
export async function reconcileProPurchases(
  db: Database,
  input: {
    provider: ProCheckoutProvider;
    providerName: string;
    now: Date;
    sealing: MailSealing;
    successUrl?: string;
    cancelUrl?: string;
    minAgeMs?: number;
    limit?: number;
  },
): Promise<{
  paid: {
    profileId: string | null;
    businessId: string | null;
    handleLower: string | null;
    planChanged: boolean;
  }[];
  checked: number;
  failed: number;
}> {
  const { now } = input;
  const before = new Date(now.getTime() - (input.minAgeMs ?? STALE_AFTER_MS));
  const rows = await db
    .select()
    .from(proPurchases)
    .where(
      and(
        inArray(proPurchases.status, ['PENDING', 'UNKNOWN']),
        // Balance payments have their own read-back (pro-balance.ts); a saved-card charge whose
        // answer was lost is asked again by the renewal sweep, with its own key.
        inArray(proPurchases.method, ['card', 'saved_card']),
        eq(proPurchases.provider, input.providerName),
        lte(proPurchases.createdAt, before),
        or(
          isNull(proPurchases.lastCheckedAt),
          lte(proPurchases.lastCheckedAt, before),
        ),
      ),
    )
    .orderBy(asc(proPurchases.createdAt))
    .limit(input.limit ?? 50);
  const paid: {
    profileId: string | null;
    businessId: string | null;
    handleLower: string | null;
    planChanged: boolean;
  }[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      let reference = row.providerReference;
      if (
        !reference &&
        row.status === 'UNKNOWN' &&
        row.method === 'card' &&
        input.provider.initializePlatformCheckout
      ) {
        const created = await input.provider.initializePlatformCheckout({
          purchaseId: row.id,
          amountMinor: row.amountMinor,
          currency: 'NGN',
          successUrl:
            input.successUrl ?? 'https://usetipme.xyz/dashboard/settings#plan',
          cancelUrl:
            input.cancelUrl ?? 'https://usetipme.xyz/dashboard/settings#plan',
          idempotencyKey: proIdempotencyKey(row.id),
        });
        await attachCheckout(db, {
          purchaseId: row.id,
          providerName: input.providerName,
          created,
          now,
        });
        reference = created.providerReference;
      }
      if (!reference) continue;
      const verified = await input.provider.verifyTransaction(reference);
      const result = await confirmProCheckout(db, {
        purchaseId: row.id,
        verified,
        now,
        sealing: input.sealing,
      });
      if (result.outcome === 'paid')
        paid.push({
          profileId: result.profileId,
          businessId: result.businessId,
          handleLower: result.handleLower,
          planChanged: result.planChanged,
        });
    } catch {
      // One purchase's trouble never stops the others; it is asked again next run.
      failed += 1;
    }
  }
  return { paid, checked: rows.length, failed };
}

/** A Pro month ended early by a paid refund or a lost dispute (ADR-0015): Pro ends at once. */
export async function endProForReversal(
  db: Database,
  input: { purchaseId: string; eventRowId: string; endPro: boolean; now: Date },
): Promise<{
  profileId: string;
  handleLower: string | null;
  planChanged: boolean;
}> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, input.purchaseId);
      await enqueueOutbox(tx, {
        eventType: 'pro.reversed',
        aggregateId: row.id,
        dedupeSuffix: input.eventRowId,
        payload: {
          purchaseId: row.id,
          profileId: row.profileId,
          providerEventRowId: input.eventRowId,
        },
      });
      if (!input.endPro || row.status !== 'PAID')
        return {
          profileId: personOf(row.profileId),
          handleLower: null,
          planChanged: false,
        };
      return endPaidMonth(tx, row, input.now);
    }),
  );
}

/**
 * Ends the month one payment bought, now, grace included (it no longer covers `at`); a month not
 * started yet shrinks to nothing. Nothing is deleted. Pro stays if a staff grant or another month
 * still covers now (ruling 4). Called under the purchase's lock.
 */
export async function endPaidMonth(
  tx: Tx,
  row: { id: string; profileId: string | null },
  at: Date,
): Promise<{
  profileId: string;
  handleLower: string | null;
  planChanged: boolean;
}> {
  const profileId = personOf(row.profileId);
  const [page] = await tx
    .select({ handleLower: profiles.handleLower })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for('update');
  await tx.execute(sql`
    UPDATE pro_periods
       SET status = 'ENDED',
           ends_at = GREATEST(starts_at + interval '1 millisecond',
                              LEAST(ends_at, ${at}::timestamptz - interval '2 milliseconds')),
           grace_ends_at = GREATEST(starts_at + interval '1 millisecond',
                              LEAST(ends_at, ${at}::timestamptz - interval '2 milliseconds'))
                           + interval '1 millisecond'
     WHERE purchase_id = ${row.id} AND status <> 'ENDED'`);
  const plan = await recomputePlan(tx, profileId, at);
  return {
    profileId,
    handleLower: page?.handleLower ?? null,
    planChanged: plan.changed,
  };
}

/** Everything `GET /v1/me/pro` shows, read at `now`. */
export async function myProState(
  db: Database,
  profileId: string,
  now: Date = new Date(),
): Promise<{
  plan: 'free' | 'pro';
  staffPro: boolean;
  current: {
    startsAt: Date;
    endsAt: Date;
    graceEndsAt: Date;
    paidBy: string;
  } | null;
  next: { startsAt: Date; endsAt: Date } | null;
  openPurchase: ProPurchaseView | null;
  price: { amountMinor: bigint; currency: 'NGN' } | null;
}> {
  const [page] = await db
    .select({ plan: profiles.plan, staffPro: profiles.staffPro })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!page) throw new OperationError('PROFILE_NOT_FOUND');
  const periods = await db
    .select()
    .from(proPeriods)
    .where(eq(proPeriods.profileId, profileId))
    .orderBy(asc(proPeriods.startsAt));
  const current =
    periods.find((p) => p.startsAt <= now && now < p.graceEndsAt) ?? null;
  const next = periods.find((p) => p.status === 'SCHEDULED') ?? null;
  const price = await currentProPrice(db, now);
  return {
    plan: page.plan === 'pro' ? 'pro' : 'free',
    staffPro: page.staffPro,
    current: current
      ? {
          startsAt: current.startsAt,
          endsAt: current.endsAt,
          graceEndsAt: current.graceEndsAt,
          paidBy: current.paidBy,
        }
      : null,
    next: next ? { startsAt: next.startsAt, endsAt: next.endsAt } : null,
    openPurchase: await openProPurchase(db, profileId),
    price: price ? { amountMinor: price.amountMinor, currency: 'NGN' } : null,
  };
}

/** A page's current handle, lower-cased (the live-checkout list names handles). */
export async function pageHandleLower(
  db: Database,
  profileId: string,
): Promise<string | null> {
  const [page] = await db
    .select({ handleLower: profiles.handleLower })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return page?.handleLower ?? null;
}

/** One purchase by id, for the pretend checkout page (which has no session). */
export async function myProPurchaseById(
  db: Database,
  purchaseId: string,
): Promise<ProPurchaseView | null> {
  const [row] = await db
    .select()
    .from(proPurchases)
    .where(eq(proPurchases.id, purchaseId));
  return row ? view(row) : null;
}
