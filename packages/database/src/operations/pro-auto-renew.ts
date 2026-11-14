import { lagosDateWords } from '@tipme/domain';
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  proAutoRenew,
  proPeriods,
  proPurchases,
  profiles,
  users,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { personOf } from './owner.js';
import { guarded, OperationError } from './errors.js';
import type { MailSealing } from './mail-queue.js';
import {
  lockPurchase,
  move,
  proIdempotencyKey,
  requestProPurchase,
  type PurchaseRow,
} from './pro-purchases.js';
import { currentProPrice } from './pro-price.js';

/*
 * Auto-renew on a saved naira card (plan Task 10; ruling 9), behind PRO_AUTO_RENEW (off by default).
 * The partner bills subscriptions in USD only, so TipMe renews by itself: the person ticks it on a
 * card checkout (the card is saved as they pay), then one off-session charge a day before the month
 * ends, once per month (`renews_period_id` is unique) with the key `tipme-pro-<purchaseId>`. A
 * refusal sends `pro_renewal_failed` and the month runs into its grace as usual; nothing is tried
 * again for it. Turning it off forgets the saved card, so nothing more can be charged.
 */

/** The partner calls auto-renew needs. */
export interface ProAutoRenewProvider {
  createPlatformCustomer?(input: {
    email: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ customerReference: string }>;
  chargeSavedCard?(input: {
    customerReference: string;
    paymentMethodReference: string;
    amountMinor: bigint;
    currency: 'NGN';
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    providerReference: string;
    status: 'succeeded' | 'pending' | 'failed';
  }>;
}

export interface ProAutoRenewState {
  /** The person wants it, and a card is saved to charge. */
  on: boolean;
  cardSaved: boolean;
}

/** One day before the month ends (the plan's `ends_at − 24h`). */
const RENEW_LEAD_MS = 24 * 3_600_000;
/** A lost charge answer is asked again (same key) no sooner than this. */
const RETRY_AFTER_MS = 5 * 60_000;

export async function proAutoRenewState(
  db: Database | Tx,
  profileId: string,
): Promise<ProAutoRenewState> {
  const [row] = await db
    .select()
    .from(proAutoRenew)
    .where(eq(proAutoRenew.profileId, profileId));
  const cardSaved = Boolean(row?.paymentMethodReference);
  return { on: Boolean(row?.enabled) && cardSaved, cardSaved };
}

/**
 * Before a checkout with auto-renew ticked: the person's customer on TipMe's own partner account,
 * made once (its key is the page's) and kept. The email is the account's own; the name the page's.
 */
export async function prepareProAutoRenew(
  db: Database,
  input: {
    profileId: string;
    provider: ProAutoRenewProvider;
    providerName: string;
  },
): Promise<string> {
  const [existing] = await db
    .select()
    .from(proAutoRenew)
    .where(eq(proAutoRenew.profileId, input.profileId));
  if (existing?.customerReference && existing.provider === input.providerName)
    return existing.customerReference;
  if (!input.provider.createPlatformCustomer)
    throw new OperationError('PRO_AUTO_RENEW_OFF');
  const [owner] = await db
    .select({ email: users.email, name: profiles.displayName })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.id, input.profileId));
  if (!owner?.email) throw new OperationError('PRO_AUTO_RENEW_NEEDS_EMAIL');
  const { customerReference } = await input.provider.createPlatformCustomer({
    email: owner.email,
    name: owner.name || 'TipMe member',
    idempotencyKey: `tipme-pro-customer-${input.profileId}`,
  });
  await guarded(() =>
    db
      .insert(proAutoRenew)
      .values({
        profileId: input.profileId,
        provider: input.providerName,
        enabled: false,
        customerReference,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: proAutoRenew.profileId,
        set: {
          provider: input.providerName,
          customerReference,
          paymentMethodReference: null,
          enabled: false,
          updatedAt: new Date(),
        },
      }),
  );
  return customerReference;
}

/**
 * The partner saved a card on TipMe's own account (`payment_method.saved`, or the pretend partner's
 * read-back). Only a customer the person opted in with turns auto-renew on; any other is ignored.
 */
export async function recordSavedCardIn(
  tx: Database | Tx,
  input: {
    provider: string;
    customerReference: string;
    paymentMethodReference: string;
    now: Date;
  },
): Promise<string | null> {
  const [row] = await tx
    .update(proAutoRenew)
    .set({
      paymentMethodReference: input.paymentMethodReference,
      enabled: true,
      failedPeriodId: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(proAutoRenew.provider, input.provider),
        eq(proAutoRenew.customerReference, input.customerReference),
      ),
    )
    .returning({ profileId: proAutoRenew.profileId });
  return row?.profileId ?? null;
}

export function recordSavedCard(
  db: Database,
  input: {
    provider: string;
    customerReference: string;
    paymentMethodReference: string;
    now: Date;
  },
): Promise<string | null> {
  return guarded(() => recordSavedCardIn(db, input));
}

/** "Turn off auto-renew": always allowed; the saved card is forgotten, so nothing is charged. */
export async function turnOffProAutoRenew(
  db: Database,
  input: { profileId: string; now: Date },
): Promise<ProAutoRenewState> {
  await guarded(() =>
    db
      .update(proAutoRenew)
      .set({
        enabled: false,
        paymentMethodReference: null,
        updatedAt: input.now,
      })
      .where(eq(proAutoRenew.profileId, input.profileId)),
  );
  return proAutoRenewState(db, input.profileId);
}

/**
 * A renewal refused: the email once per month, and the month marked, so its reminders go as usual.
 * Called in the transaction that failed the purchase.
 */
export async function renewalFailedIn(
  tx: Tx,
  sealing: MailSealing,
  row: Pick<PurchaseRow, 'profileId' | 'renewsPeriodId'>,
  now: Date,
): Promise<void> {
  if (!row.renewsPeriodId) return;
  const [period] = await tx
    .select()
    .from(proPeriods)
    .where(eq(proPeriods.id, row.renewsPeriodId));
  if (!period) return;
  await tx
    .update(proAutoRenew)
    .set({ failedPeriodId: period.id, updatedAt: now })
    .where(eq(proAutoRenew.profileId, personOf(row.profileId)));
  await mailOwner(tx, sealing, {
    profileId: personOf(row.profileId),
    type: 'pro_renewal_failed',
    data: {
      endDate: lagosDateWords(period.endsAt),
      graceEndDate: lagosDateWords(period.graceEndsAt),
    },
    dedupeKey: `pro_renewal_failed.${period.id}`,
    now,
  });
}

/** Whether the saved card is the reason nothing would ever be charged (no card, removed). */
function definitelyNotCharged(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'SavedCardRefusedError' ||
    error.name === 'BachsRequestNotSentError'
  );
}

/** Applies the partner's answer to one charge request (or its loss). */
async function afterCharge(
  db: Database,
  input: {
    purchaseId: string;
    sealing: MailSealing;
    now: Date;
    outcome:
      | { kind: 'answered'; providerReference: string; status: string }
      | { kind: 'refused' }
      | { kind: 'lost' };
  },
): Promise<void> {
  await guarded(() =>
    db.transaction(async (tx) => {
      const row = await lockPurchase(tx, input.purchaseId);
      if (row.status !== 'COLLECTING' && row.status !== 'UNKNOWN') return;
      const { outcome, now } = input;
      await tx
        .update(proPurchases)
        .set({ lastCheckedAt: now })
        .where(eq(proPurchases.id, row.id));
      if (outcome.kind === 'lost') {
        if (row.status === 'COLLECTING')
          await move(tx, row, 'UNKNOWN', { now, cause: 'system' });
        return;
      }
      if (outcome.kind === 'refused' || outcome.status === 'failed') {
        await move(tx, row, 'FAILED', {
          now,
          cause: 'system',
          ...(outcome.kind === 'answered'
            ? { set: { providerReference: outcome.providerReference } }
            : {}),
        });
        await renewalFailedIn(tx, input.sealing, row, now);
        return;
      }
      // Processing is not success: the read-back (webhook or reconciliation) decides.
      await move(tx, row, 'PENDING', {
        now,
        cause: 'system',
        set: { providerReference: outcome.providerReference },
      });
    }),
  );
}

async function chargeOnce(
  db: Database,
  input: {
    provider: ProAutoRenewProvider;
    purchase: PurchaseRow;
    customerReference: string;
    paymentMethodReference: string;
    sealing: MailSealing;
    now: Date;
  },
): Promise<void> {
  const charge = input.provider.chargeSavedCard;
  if (!charge) return;
  let outcome: Parameters<typeof afterCharge>[1]['outcome'];
  try {
    const answer = await charge.call(input.provider, {
      customerReference: input.customerReference,
      paymentMethodReference: input.paymentMethodReference,
      amountMinor: input.purchase.amountMinor,
      currency: 'NGN',
      reference: input.purchase.id,
      idempotencyKey: proIdempotencyKey(input.purchase.id),
    });
    outcome = {
      kind: 'answered',
      providerReference: answer.providerReference,
      status: answer.status,
    };
  } catch (error) {
    outcome = definitelyNotCharged(error)
      ? { kind: 'refused' }
      : { kind: 'lost' };
  }
  await afterCharge(db, {
    purchaseId: input.purchase.id,
    sealing: input.sealing,
    now: input.now,
    outcome,
  });
}

/**
 * The renewal sweep (`pro.renew`, every 15 minutes, only with PRO_AUTO_RENEW on). Each month in its
 * last day whose page has auto-renew on, with no month queued and no purchase open, gets exactly one
 * `saved_card` purchase and one charge. A charge whose answer was lost is asked again with the same
 * key (the partner returns the same charge for it), never with a new one.
 */
export async function renewProAutomatically(
  db: Database,
  input: {
    provider: ProAutoRenewProvider;
    providerName: string;
    now: Date;
    sealing: MailSealing;
    limit?: number;
  },
): Promise<{ charged: number; retried: number }> {
  const { now } = input;
  const due = await db
    .select({
      periodId: proPeriods.id,
      profileId: proPeriods.profileId,
      customerReference: proAutoRenew.customerReference,
      paymentMethodReference: proAutoRenew.paymentMethodReference,
    })
    .from(proPeriods)
    .innerJoin(proAutoRenew, eq(proAutoRenew.profileId, proPeriods.profileId))
    .where(
      and(
        eq(proPeriods.status, 'ACTIVE'),
        gt(proPeriods.endsAt, now),
        lte(proPeriods.endsAt, new Date(now.getTime() + RENEW_LEAD_MS)),
        eq(proAutoRenew.enabled, true),
        eq(proAutoRenew.provider, input.providerName),
        isNotNull(proAutoRenew.paymentMethodReference),
        sql`NOT EXISTS (SELECT 1 FROM pro_purchases r WHERE r.renews_period_id = ${proPeriods.id})`,
        sql`NOT EXISTS (SELECT 1 FROM pro_periods queued
               WHERE queued.profile_id = ${proPeriods.profileId} AND queued.status = 'SCHEDULED')`,
      ),
    )
    .orderBy(asc(proPeriods.endsAt))
    .limit(input.limit ?? 50);
  let charged = 0;
  const price = due.length > 0 ? await currentProPrice(db, now) : null;
  for (const row of due) {
    if (!price || !row.customerReference || !row.paymentMethodReference) break;
    let purchase: PurchaseRow;
    try {
      ({ purchase } = await requestProPurchase(db, {
        profileId: personOf(row.profileId),
        method: 'saved_card',
        expectedAmountMinor: price.amountMinor,
        // One per month: a second run finds the purchase and stops (renews_period_id is unique).
        idempotencyKey: `pro-renew.${row.periodId}`,
        status: 'COLLECTING',
        extra: { renewsPeriodId: row.periodId, provider: input.providerName },
        now,
      }));
      if (purchase.status !== 'COLLECTING') continue;
    } catch {
      // A purchase opened by hand, a month queued meanwhile: nothing to renew.
      continue;
    }
    await chargeOnce(db, {
      provider: input.provider,
      purchase,
      customerReference: row.customerReference,
      paymentMethodReference: row.paymentMethodReference,
      sealing: input.sealing,
      now,
    });
    charged += 1;
  }
  // Lost answers: asked again with the same key, no more than every few minutes.
  const lost = await db
    .select({
      purchase: proPurchases,
      customerReference: proAutoRenew.customerReference,
      paymentMethodReference: proAutoRenew.paymentMethodReference,
    })
    .from(proPurchases)
    .innerJoin(proAutoRenew, eq(proAutoRenew.profileId, proPurchases.profileId))
    .where(
      and(
        eq(proPurchases.method, 'saved_card'),
        inArray(proPurchases.status, ['UNKNOWN']),
        eq(proPurchases.provider, input.providerName),
        lte(
          proPurchases.lastCheckedAt,
          new Date(now.getTime() - RETRY_AFTER_MS),
        ),
      ),
    )
    .limit(input.limit ?? 50);
  let retried = 0;
  for (const row of lost) {
    // Turned off since: the card is forgotten, and the purchase stays for staff.
    if (!row.customerReference || !row.paymentMethodReference) continue;
    await chargeOnce(db, {
      provider: input.provider,
      purchase: row.purchase,
      customerReference: row.customerReference,
      paymentMethodReference: row.paymentMethodReference,
      sealing: input.sealing,
      now,
    });
    retried += 1;
  }
  return { charged, retried };
}
