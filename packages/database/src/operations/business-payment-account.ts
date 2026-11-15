import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { businesses, paymentAccounts, users } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import type { PaymentAccountEnvironment } from './payment-accounts.js';

/*
 * Business release 2 on option B: a business's own partner account, which only receives (the
 * partner's recipient persona: payouts and transfers; sandbox S1). It takes no card payments, so it
 * needs no selfie check or review; live, the partner asks for the business's registered name and a
 * payout account in that name. It is ACTIVE once our partner says it can pay out and receive
 * transfers and TipMe has switched its payouts to manual (so only TipMe's withdrawals spend it).
 */

export interface BusinessAccountRow {
  id: string;
  status: string;
  providerAccountReference: string | null;
  requirementsDue: string[];
  manualPayouts: boolean;
}

const view = (
  row: typeof paymentAccounts.$inferSelect,
): BusinessAccountRow => ({
  id: row.id,
  status: row.status,
  providerAccountReference: row.providerAccountReference,
  requirementsDue: row.requirementsDue,
  manualPayouts: row.manualPayoutsAt !== null,
});

type Where = {
  businessId: string;
  provider: string;
  environment: PaymentAccountEnvironment;
};

const owned = (input: Where) =>
  and(
    eq(paymentAccounts.businessId, input.businessId),
    eq(paymentAccounts.provider, input.provider),
    eq(paymentAccounts.environment, input.environment),
  );

export function businessPaymentAccount(
  db: Database,
  input: Where,
): Promise<BusinessAccountRow | null> {
  return guarded(async () => {
    const [row] = await db.select().from(paymentAccounts).where(owned(input));
    return row ? view(row) : null;
  });
}

/**
 * Claims the business's account row before our partner is asked to make one, so two owners at
 * once ask once (the key is `tipme-biz-acct-<row id>`). A row that failed definitely starts again.
 * Also hands back what the account is made with: the business's name and the acting owner's
 * verified address (which only our partner sees).
 */
export function claimBusinessPaymentAccount(
  db: Database,
  input: Where & { userId: string; now?: Date },
): Promise<{
  created: boolean;
  account: BusinessAccountRow;
  businessName: string;
  contactEmail: string | null;
}> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [business] = await tx
        .select({ name: businesses.name, status: businesses.status })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .for('update');
      if (!business) throw new OperationError('NOT_A_MANAGER');
      if (business.status !== 'verified')
        throw new OperationError('BUSINESS_NOT_VERIFIED');
      const [owner] = await tx
        .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, input.userId));
      const contactEmail =
        owner?.email && owner.verifiedAt ? owner.email : null;
      const extra = { businessName: business.name, contactEmail };
      const [existing] = await tx
        .select()
        .from(paymentAccounts)
        .where(owned(input))
        .for('update');
      if (existing && existing.status !== 'FAILED')
        return { created: false, account: view(existing), ...extra };
      if (!contactEmail)
        throw new OperationError('EMAIL_VERIFICATION_REQUIRED');
      if (existing) {
        const [restarted] = await tx
          .update(paymentAccounts)
          .set({
            status: 'CREATING',
            providerAccountReference: null,
            requirementsDue: [],
            updatedAt: now,
          })
          .where(eq(paymentAccounts.id, existing.id))
          .returning();
        return { created: true, account: view(restarted!), ...extra };
      }
      const [account] = await tx
        .insert(paymentAccounts)
        .values({
          id: newId(),
          businessId: input.businessId,
          provider: input.provider,
          environment: input.environment,
          status: 'CREATING',
          receiveOnly: true,
          feeCollector: 'platform',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { created: true, account: view(account!), ...extra };
    }),
  );
}

/** What our partner said about the business's account. A reference, once written, never changes. */
export function recordBusinessPaymentAccount(
  db: Database,
  input: Where & {
    status: 'ONBOARDING' | 'ACTIVE' | 'RESTRICTED' | 'FAILED' | 'UNKNOWN';
    providerAccountReference?: string;
    requirementsDue?: string[];
    manualPayouts?: boolean;
    now?: Date;
  },
): Promise<BusinessAccountRow> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentAccounts)
        .where(owned(input))
        .for('update');
      if (!row) throw new OperationError('PAYOUT_SETUP_NEEDED');
      if (
        input.providerAccountReference &&
        row.providerAccountReference &&
        row.providerAccountReference !== input.providerAccountReference
      )
        throw new OperationError('INVALID_INPUT');
      // ACTIVE only once payouts are TipMe's to make: else the partner could pay it out by itself.
      const manual =
        row.manualPayoutsAt !== null || input.manualPayouts === true;
      const status =
        input.status === 'ACTIVE' && !manual ? 'ONBOARDING' : input.status;
      const [updated] = await tx
        .update(paymentAccounts)
        .set({
          status,
          receiveOnly: true,
          payoutsEnabled: status === 'ACTIVE',
          ...(input.providerAccountReference
            ? { providerAccountReference: input.providerAccountReference }
            : {}),
          ...(input.requirementsDue
            ? { requirementsDue: input.requirementsDue.slice(0, 50) }
            : {}),
          ...(input.manualPayouts && !row.manualPayoutsAt
            ? { manualPayoutsAt: now }
            : {}),
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(paymentAccounts.id, row.id))
        .returning();
      return view(updated!);
    }),
  );
}
