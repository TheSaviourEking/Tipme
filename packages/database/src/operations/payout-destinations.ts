import { recordedProviderName } from '@tipme/contracts';
import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  paymentAccounts,
  payoutDestinations,
  profiles,
  users,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import {
  checkEmailCode,
  issueEmailCode,
  type EmailCodeCheck,
} from './email-sign-in.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import type { MailSealing } from './mail-queue.js';
import {
  bachsAccountEnvironment,
  type PaymentAccountEnvironment,
} from './payment-accounts.js';

export type PayoutDestinationStatus = 'usable' | 'pending_review' | 'rejected';

const STATUSES = new Set<string>(['usable', 'pending_review', 'rejected']);

/** The verified address a bank-account code goes to. A code proves that inbox, nothing else. */
async function verifiedEmailOf(
  db: Pick<Database, 'select'>,
  userId: string,
): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    );
  return user?.email?.toLowerCase() ?? null;
}

/** Sends a code to the account's own verified address; the caller never names one. */
export function requestPayoutDestinationCode(
  db: Database,
  sealing: MailSealing,
  input: { userId: string; secret: string; now?: Date },
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' | 'no_email' }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const email = await verifiedEmailOf(tx, input.userId);
      if (!email) return { status: 'no_email' as const };
      return {
        status: await issueEmailCode(tx, sealing, {
          email,
          purpose: 'payout_destination',
          mailType: 'payout_destination_code',
          secret: input.secret,
          userId: input.userId,
          now,
        }),
      };
    }),
  );
}

/**
 * Checks and spends a code, committing before the provider is called so no transaction spans the
 * network. One code buys one attempt: a provider failure after this asks for a new code.
 */
export function spendPayoutDestinationCode(
  db: Database,
  input: { userId: string; code: string; secret: string; now?: Date },
): Promise<EmailCodeCheck | 'no_email'> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const email = await verifiedEmailOf(tx, input.userId);
      if (!email) return 'no_email' as const;
      return checkEmailCode(tx, {
        email,
        purpose: 'payout_destination',
        code: input.code,
        secret: input.secret,
        now,
      });
    }),
  );
}

/**
 * Makes this the account withdrawals go to. The profile lock serialises this with another change
 * and with `requestWithdrawal` (including a first add, when no destination row exists to lock), so
 * only one can be current and a payout never records an account replaced under it. The account
 * number never reaches here. Payouts keep the row they recorded, so old rows stay.
 */
export function setPayoutDestination(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    destinationRef: string;
    bankCode: string;
    bankName: string;
    last4: string;
    status: PayoutDestinationStatus;
    sealing: MailSealing;
    now?: Date;
  },
): Promise<{ replaced: boolean }> {
  const now = input.now ?? new Date();
  if (
    input.destinationRef.trim() === '' ||
    input.bankName.trim() === '' ||
    !/^\d{4}$/.test(input.last4) ||
    !STATUSES.has(input.status)
  )
    return Promise.reject(new OperationError('INVALID_INPUT'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!profile) throw new OperationError('NO_PAGE');
      const [current] = await tx
        .select()
        .from(payoutDestinations)
        .where(
          and(
            eq(payoutDestinations.profileId, input.profileId),
            eq(payoutDestinations.provider, input.provider),
            isNull(payoutDestinations.replacedAt),
          ),
        )
        .for('update');
      // The same account sent again: the provider's newest word on it, and nothing has changed.
      if (current?.destinationReference === input.destinationRef) {
        await tx
          .update(payoutDestinations)
          .set({ status: input.status })
          .where(eq(payoutDestinations.id, current.id));
        return { replaced: false };
      }
      if (current)
        await tx
          .update(payoutDestinations)
          .set({ replacedAt: now })
          .where(eq(payoutDestinations.id, current.id));
      const id = newId();
      await tx.insert(payoutDestinations).values({
        id,
        profileId: input.profileId,
        provider: input.provider,
        destinationReference: input.destinationRef,
        bankCode: input.bankCode,
        bankName: input.bankName,
        accountLast4: input.last4,
        status: input.status,
        createdAt: now,
      });
      if (current)
        await mailOwner(tx, input.sealing, {
          profileId: input.profileId,
          type: 'payout_destination_changed',
          data: {
            bankName: input.bankName,
            last4: input.last4,
            previousBankName: current.bankName,
            previousLast4: current.accountLast4,
          },
          dedupeKey: `payout_destination_changed.${id}`,
          now,
        });
      return { replaced: Boolean(current) };
    }),
  );
}

export function getPayoutDestination(
  db: Database,
  input: { profileId: string; provider: string },
): Promise<{
  id: string;
  destinationRef: string;
  status: PayoutDestinationStatus;
  bankName: string;
  last4: string;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        id: payoutDestinations.id,
        destinationRef: payoutDestinations.destinationReference,
        status: payoutDestinations.status,
        bankName: payoutDestinations.bankName,
        last4: payoutDestinations.accountLast4,
      })
      .from(payoutDestinations)
      .where(
        and(
          eq(payoutDestinations.profileId, input.profileId),
          eq(payoutDestinations.provider, input.provider),
          isNull(payoutDestinations.replacedAt),
        ),
      );
    return row
      ? { ...row, status: row.status as PayoutDestinationStatus }
      : null;
  });
}

/** Records the end of a review. Only a pending, current row moves: a read revives nothing. */
export function settlePendingPayoutDestination(
  db: Database,
  input: { id: string; status: PayoutDestinationStatus },
): Promise<boolean> {
  if (!STATUSES.has(input.status))
    return Promise.reject(new OperationError('INVALID_INPUT'));
  if (input.status === 'pending_review') return Promise.resolve(false);
  return guarded(async () => {
    const updated = await db
      .update(payoutDestinations)
      .set({ status: input.status })
      .where(
        and(
          eq(payoutDestinations.id, input.id),
          eq(payoutDestinations.status, 'pending_review'),
          isNull(payoutDestinations.replacedAt),
        ),
      )
      .returning({ id: payoutDestinations.id });
    return updated.length > 0;
  });
}

/** What setting up an account for payouts asks of the provider; structural, as in ADR-0004. */
export interface PayoutSetupProvider {
  name: string;
  environment: PaymentAccountEnvironment;
  setManualPayouts(accountRef: string): Promise<void>;
  payoutCapability(accountRef: string): Promise<{ status: string }>;
  requestPayoutCapabilities(accountRef: string): Promise<void>;
  payoutDestinationStatus(
    accountRef: string,
    destinationRef: string,
  ): Promise<PayoutDestinationStatus>;
}

/** Told which step failed and the error's type. Never carries account data. */
export type PayoutSetupLog = (entry: {
  event: string;
  provider: 'bachs';
  error: string;
}) => void;

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : typeof error;

type SetupRow = Pick<
  typeof paymentAccounts.$inferSelect,
  | 'id'
  | 'providerAccountReference'
  | 'manualPayoutsAt'
  | 'payoutCapabilitiesRequestedAt'
>;

/**
 * Each step stands alone, so one failing never holds up the other, and each is marked only once the
 * provider has answered: a failure leaves it null, for the next refresh or sweep to try again.
 * Withdrawals stay blocked until manual payouts are marked (`routeBlock`). Both calls are safe to
 * repeat. Capabilities go first because the provider may need them before it accepts a schedule.
 */
async function applyPayoutSetup(
  db: Database,
  provider: PayoutSetupProvider,
  account: SetupRow,
  log?: PayoutSetupLog,
): Promise<number> {
  const reference = account.providerAccountReference;
  if (!reference) return 0;
  let failed = 0;
  const step = async (event: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failed += 1;
      log?.({ event, provider: 'bachs', error: errorName(error) });
    }
  };
  if (!account.payoutCapabilitiesRequestedAt)
    await step('payment_account.capabilities_failed', async () => {
      const { status } = await provider.payoutCapability(reference);
      if (status === 'missing')
        await provider.requestPayoutCapabilities(reference);
      await guarded(() =>
        db
          .update(paymentAccounts)
          .set({ payoutCapabilitiesRequestedAt: new Date() })
          .where(eq(paymentAccounts.id, account.id)),
      );
    });
  if (!account.manualPayoutsAt)
    await step('payment_account.manual_payouts_failed', async () => {
      await provider.setManualPayouts(reference);
      await guarded(() =>
        db
          .update(paymentAccounts)
          .set({ manualPayoutsAt: new Date() })
          .where(eq(paymentAccounts.id, account.id)),
      );
    });
  return failed;
}

/** The account's refresh path: finishes its setup, and picks up a bank review that has ended. */
export async function ensurePayoutSetup(
  db: Database,
  input: {
    profileId: string;
    provider: PayoutSetupProvider;
    log?: PayoutSetupLog;
  },
): Promise<void> {
  const environment = bachsAccountEnvironment(input.provider.environment);
  const [account] = await guarded(() =>
    db
      .select()
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(
            paymentAccounts.provider,
            recordedProviderName(input.provider.name),
          ),
          eq(paymentAccounts.environment, environment),
        ),
      ),
  );
  if (!account) return;
  await applyPayoutSetup(db, input.provider, account, input.log);
  await refreshPendingDestination(db, input.provider, {
    profileId: input.profileId,
    accountReference: account.providerAccountReference,
    log: input.log,
  });
}

/** Asks where a pending destination's review stands. A failed read changes nothing. */
export async function refreshPendingDestination(
  db: Database,
  provider: Pick<PayoutSetupProvider, 'name' | 'payoutDestinationStatus'>,
  input: {
    profileId: string;
    accountReference: string | null;
    log?: PayoutSetupLog | undefined;
  },
): Promise<boolean> {
  if (!input.accountReference) return false;
  const current = await getPayoutDestination(db, {
    profileId: input.profileId,
    provider: recordedProviderName(provider.name),
  });
  if (current?.status !== 'pending_review') return false;
  try {
    const status = await provider.payoutDestinationStatus(
      input.accountReference,
      current.destinationRef,
    );
    return await settlePendingPayoutDestination(db, {
      id: current.id,
      status,
    });
  } catch (error) {
    input.log?.({
      event: 'payout_destination.read_failed',
      provider: 'bachs',
      error: errorName(error),
    });
    return false;
  }
}

const SWEEP_PAGE = 100;

/**
 * The worker's sweep: every account in this environment still missing a step of its setup, which
 * reaches accounts made before this and ones that never receive an event, and every bank under
 * review. Walks by id, so an account that keeps failing can't crowd out the ones behind it.
 */
export async function sweepPayoutSetup(
  db: Database,
  input: { provider: PayoutSetupProvider; log?: PayoutSetupLog },
): Promise<{ checked: number; failed: number; destinationsSettled: number }> {
  const environment = bachsAccountEnvironment(input.provider.environment);
  const stored = recordedProviderName(input.provider.name);
  const totals = { checked: 0, failed: 0, destinationsSettled: 0 };
  let after: string | null = null;
  for (;;) {
    const page: SetupRow[] = await guarded(() =>
      db
        .select({
          id: paymentAccounts.id,
          providerAccountReference: paymentAccounts.providerAccountReference,
          manualPayoutsAt: paymentAccounts.manualPayoutsAt,
          payoutCapabilitiesRequestedAt:
            paymentAccounts.payoutCapabilitiesRequestedAt,
        })
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.provider, stored),
            eq(paymentAccounts.environment, environment),
            isNotNull(paymentAccounts.providerAccountReference),
            or(
              isNull(paymentAccounts.manualPayoutsAt),
              isNull(paymentAccounts.payoutCapabilitiesRequestedAt),
            ),
            after ? gt(paymentAccounts.id, after) : undefined,
          ),
        )
        .orderBy(asc(paymentAccounts.id))
        .limit(SWEEP_PAGE),
    );
    for (const account of page) {
      totals.checked += 1;
      totals.failed += await applyPayoutSetup(
        db,
        input.provider,
        account,
        input.log,
      );
    }
    const last = page.at(-1);
    if (!last || page.length < SWEEP_PAGE) break;
    after = last.id;
  }

  let afterDestination: string | null = null;
  for (;;) {
    const pending: {
      id: string;
      profileId: string;
      accountReference: string | null;
    }[] = await guarded(() =>
      db
        .select({
          id: payoutDestinations.id,
          profileId: payoutDestinations.profileId,
          accountReference: paymentAccounts.providerAccountReference,
        })
        .from(payoutDestinations)
        .innerJoin(
          paymentAccounts,
          and(
            eq(paymentAccounts.profileId, payoutDestinations.profileId),
            eq(paymentAccounts.provider, payoutDestinations.provider),
            eq(paymentAccounts.environment, environment),
          ),
        )
        .where(
          and(
            eq(payoutDestinations.provider, stored),
            eq(payoutDestinations.status, 'pending_review'),
            isNull(payoutDestinations.replacedAt),
            afterDestination
              ? gt(payoutDestinations.id, afterDestination)
              : undefined,
          ),
        )
        .orderBy(asc(payoutDestinations.id))
        .limit(SWEEP_PAGE),
    );
    for (const row of pending)
      if (
        await refreshPendingDestination(db, input.provider, {
          profileId: row.profileId,
          accountReference: row.accountReference,
          log: input.log,
        })
      )
        totals.destinationsSettled += 1;
    const last = pending.at(-1);
    if (!last || pending.length < SWEEP_PAGE) break;
    afterDestination = last.id;
  }
  return totals;
}
