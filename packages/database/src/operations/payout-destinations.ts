import { recordedProviderName } from '@tipme/contracts';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  issues,
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
import { markResolved, openIssue } from './issues.js';
import { withdrawalsFrozen } from './payouts.js';
import type { MailSealing } from './mail-queue.js';
import {
  bachsAccountEnvironment,
  type PaymentAccountEnvironment,
} from './payment-accounts.js';

export type PayoutDestinationStatus = 'usable' | 'pending_review' | 'rejected';

const STATUSES = new Set<string>(['usable', 'pending_review', 'rejected']);

/**
 * How long a bank can't be added or changed after the sign-in email moves. A stolen session could
 * otherwise move the address, then have the bank code and the notice sent to itself, and take the
 * balance before the owner reads anything: a payout can't be cancelled. Withdrawals to the bank
 * already on the account carry on.
 */
export const BANK_CHANGE_HOLD_MS = 72 * 60 * 60 * 1000;

const heldUntil = (changedAt: Date | null, now: Date): Date | null => {
  if (!changedAt) return null;
  const until = new Date(changedAt.getTime() + BANK_CHANGE_HOLD_MS);
  return until > now ? until : null;
};

/** When this person can next add or change a bank; null when they can now. */
export function payoutBankChangesFrom(
  db: Database,
  input: { userId: string; now?: Date },
): Promise<Date | null> {
  return guarded(async () => {
    const [user] = await db
      .select({ changedAt: users.emailChangedAt })
      .from(users)
      .where(eq(users.id, input.userId));
    return heldUntil(user?.changedAt ?? null, input.now ?? new Date());
  });
}

/** The verified address a bank-account code goes to. A code proves that inbox, nothing else. */
async function codeOwner(
  db: Pick<Database, 'select'>,
  userId: string,
): Promise<{ email: string | null; changedAt: Date | null }> {
  const [user] = await db
    .select({ email: users.email, changedAt: users.emailChangedAt })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    );
  return {
    email: user?.email?.toLowerCase() ?? null,
    changedAt: user?.changedAt ?? null,
  };
}

/** Sends a code to the account's own verified address; the caller never names one. */
export function requestPayoutDestinationCode(
  db: Database,
  sealing: MailSealing,
  input: { userId: string; secret: string; now?: Date },
): Promise<{
  status: 'sent' | 'rate_limited' | 'locked' | 'no_email' | 'held';
}> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const { email, changedAt } = await codeOwner(tx, input.userId);
      if (!email) return { status: 'no_email' as const };
      if (heldUntil(changedAt, now)) return { status: 'held' as const };
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
): Promise<EmailCodeCheck | 'no_email' | 'held'> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const { email, changedAt } = await codeOwner(tx, input.userId);
      if (!email) return 'no_email' as const;
      if (heldUntil(changedAt, now)) return 'held' as const;
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
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!profile) throw new OperationError('NO_PAGE');
      // Whoever is signed in may be the thief. Checked under the same lock the freeze takes.
      if (await withdrawalsFrozen(tx, { profileId: input.profileId }))
        throw new OperationError('WITHDRAWALS_PAUSED');
      // Shared: an email change in progress finishes first, and is seen here.
      if (profile.userId) {
        const [owner] = await tx
          .select({ changedAt: users.emailChangedAt })
          .from(users)
          .where(eq(users.id, profile.userId))
          .for('share');
        if (heldUntil(owner?.changedAt ?? null, now))
          throw new OperationError('BANK_CHANGE_HELD');
      }
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
      // Rejected is permanent (provider docs), so nothing raises a rejected row.
      if (current?.destinationReference === input.destinationRef) {
        if (current.status !== 'rejected')
          await tx
            .update(payoutDestinations)
            .set({ status: input.status })
            .where(eq(payoutDestinations.id, current.id));
        return { replaced: false };
      }
      // A refused number must not strand an account that works.
      if (input.status === 'rejected' && current?.status === 'usable')
        throw new OperationError('PAYOUT_DESTINATION_REFUSED');
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

/** The provider adapter's HTTP status, read by shape (ADR-0004: its types stay in its package). */
const isRateLimited = (error: unknown) =>
  (error as { statusCode?: unknown } | null)?.statusCode === 429;

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : typeof error;

type SetupRow = Pick<
  typeof paymentAccounts.$inferSelect,
  | 'id'
  | 'profileId'
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
): Promise<{
  failed: number;
  manualFailed: boolean;
  manualTried: boolean;
  rateLimited: boolean;
}> {
  const reference = account.providerAccountReference;
  if (!reference)
    return {
      failed: 0,
      manualFailed: false,
      manualTried: false,
      rateLimited: false,
    };
  await guarded(() =>
    db
      .update(paymentAccounts)
      .set({ payoutSetupAttemptedAt: new Date() })
      .where(eq(paymentAccounts.id, account.id)),
  );
  let failed = 0;
  let manualFailed = false;
  let rateLimited = false;
  const failure = (event: string, error: unknown) => {
    failed += 1;
    rateLimited ||= isRateLimited(error);
    log?.({ event, provider: 'bachs', error: errorName(error) });
  };
  if (!account.payoutCapabilitiesRequestedAt) {
    try {
      const { status } = await provider.payoutCapability(reference);
      if (status === 'missing')
        await provider.requestPayoutCapabilities(reference);
      await guarded(() =>
        db
          .update(paymentAccounts)
          .set({ payoutCapabilitiesRequestedAt: new Date() })
          .where(eq(paymentAccounts.id, account.id)),
      );
    } catch (error) {
      failure('payment_account.capabilities_failed', error);
    }
  }
  if (!account.manualPayoutsAt) {
    try {
      await provider.setManualPayouts(reference);
      await markManualPayoutsSet(db, account.id);
    } catch (error) {
      manualFailed = true;
      failure('payment_account.manual_payouts_failed', error);
      await tellStaffSetupFailed(db, account, log);
    }
  }
  return {
    failed,
    manualFailed,
    manualTried: !account.manualPayoutsAt,
    rateLimited,
  };
}

const setupIssueKey = (accountId: string) =>
  `payment_account_setup.${accountId}`;

/** Stamped with its issue closed, so staff never see "not set" about an account that is. */
function markManualPayoutsSet(db: Database, accountId: string): Promise<void> {
  const now = new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .update(paymentAccounts)
        .set({ manualPayoutsAt: now })
        .where(eq(paymentAccounts.id, accountId));
      const [open] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.dedupeKey, setupIssueKey(accountId)),
            eq(issues.status, 'open'),
          ),
        );
      if (open)
        await markResolved(tx, {
          issueId: open.id,
          resolvedBy: 'system',
          staffUserId: null,
          reason: 'Manual payouts are now set on the account.',
          now,
        });
    }),
  );
}

/** One issue per account however often it fails. Failing to raise it must not stop the caller. */
async function tellStaffSetupFailed(
  db: Database,
  account: SetupRow,
  log?: PayoutSetupLog,
): Promise<void> {
  try {
    await guarded(() =>
      openIssue(db, {
        dedupeKey: setupIssueKey(account.id),
        kind: 'payment_account_setup_failed',
        subject: { profileId: account.profileId ?? undefined },
        now: new Date(),
      }),
    );
  } catch (error) {
    log?.({
      event: 'payment_account.setup_issue_failed',
      provider: 'bachs',
      error: errorName(error),
    });
  }
}

/** The account's refresh path: finishes its setup, and picks up a bank review that has ended. */
export async function ensurePayoutSetup(
  db: Database,
  input: {
    profileId: string;
    provider: PayoutSetupProvider;
    log?: PayoutSetupLog;
  },
): Promise<{ manualPayouts: boolean }> {
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
  if (!account) return { manualPayouts: false };
  await applyPayoutSetup(db, input.provider, account, input.log);
  await refreshPendingDestination(db, input.provider, {
    profileId: input.profileId,
    accountReference: account.providerAccountReference,
    log: input.log,
  });
  const [after] = await guarded(() =>
    db
      .select({ at: paymentAccounts.manualPayoutsAt })
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, account.id)),
  );
  return { manualPayouts: Boolean(after?.at) };
}

/** Asks where a pending destination's review stands. A failed read changes nothing. */
export async function refreshPendingDestination(
  db: Database,
  provider: Pick<PayoutSetupProvider, 'name' | 'payoutDestinationStatus'>,
  input: {
    profileId: string;
    accountReference: string | null;
    log?: PayoutSetupLog | undefined;
    /** Told when the provider read fails, for a caller pacing many reads. */
    onReadFailure?: ((error: unknown) => void) | undefined;
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
    input.onReadFailure?.(error);
    return false;
  }
}

const SWEEP_PAGE = 100;

/**
 * Pending banks read per run. These reads use the same provider key as real payouts, so a backlog
 * must never spend that key's limit. The sweep runs every 15 minutes, and a bank not reached waits
 * for a later run: each run picks at random, so no bank waits behind others for good.
 */
export const PAYOUT_SWEEP_MAX_DESTINATION_READS = 100;
/**
 * Accounts set up per run, and so about three provider calls each. The rest wait for a later run,
 * least recently tried first, and a backlog can't outlast the sweep's lock.
 */
export const PAYOUT_SWEEP_MAX_ACCOUNTS = 100;
/** This many 429s together: the provider key is at its limit, so that phase ends for this run. */
export const PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW = 3;

/**
 * This many manual-payouts failures together look like the provider being down, so the account
 * phase ends there. Reading banks under review always runs after it: failures alone don't stop
 * those reads, which could leave a good bank behind unreadable ones on every run. Only the
 * provider key's own limit does (below).
 */
export const PAYOUT_SWEEP_MAX_FAILURES_IN_A_ROW = 5;

/**
 * The worker's sweep: every account in this environment still missing a step of its setup, which
 * reaches accounts made before this and ones that never receive an event, and every bank under
 * review. Least recently tried first, so accounts that keep failing go to the back and can't crowd
 * out the rest, even when a run ends early.
 */
export async function sweepPayoutSetup(
  db: Database,
  input: {
    provider: PayoutSetupProvider;
    log?: PayoutSetupLog;
    maxFailuresInARow?: number;
    maxDestinationReads?: number;
    maxAccounts?: number;
  },
): Promise<{
  checked: number;
  failed: number;
  destinationsSettled: number;
  destinationReadsFailed: number;
  destinationReadsStopped: boolean;
  accountsCapped: boolean;
  stoppedEarly: boolean;
  /**
   * Pages whose recorded setup changed (manual payouts set, or a bank under review settled), for
   * live updates' payments.changed. Ids, so never log this field.
   */
  changedProfileIds: string[];
}> {
  const environment = bachsAccountEnvironment(input.provider.environment);
  const stored = recordedProviderName(input.provider.name);
  const limit = input.maxFailuresInARow ?? PAYOUT_SWEEP_MAX_FAILURES_IN_A_ROW;
  const totals = {
    checked: 0,
    failed: 0,
    destinationsSettled: 0,
    destinationReadsFailed: 0,
    destinationReadsStopped: false,
    accountsCapped: false,
    stoppedEarly: false,
  };
  const changed = new Set<string>();
  const stop = (error: 'rate_limited' | 'repeated_failures') => {
    totals.stoppedEarly = true;
    input.log?.({
      event: 'payout_setup.sweep_stopped',
      provider: 'bachs',
      error,
    });
  };
  const runStart = new Date();
  let inARow = 0;
  const maxAccounts = input.maxAccounts ?? PAYOUT_SWEEP_MAX_ACCOUNTS;
  let accountsLimitedInARow = 0;
  accounts: for (;;) {
    // Each account tried is stamped past runStart, so this drains and ends.
    const page: SetupRow[] = await guarded(() =>
      db
        .select({
          id: paymentAccounts.id,
          profileId: paymentAccounts.profileId,
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
            or(
              isNull(paymentAccounts.payoutSetupAttemptedAt),
              lt(paymentAccounts.payoutSetupAttemptedAt, runStart),
            ),
          ),
        )
        .orderBy(sql`${paymentAccounts.payoutSetupAttemptedAt} ASC NULLS FIRST`)
        .limit(SWEEP_PAGE),
    );
    for (const account of page) {
      if (totals.checked >= maxAccounts) {
        totals.accountsCapped = true;
        break accounts;
      }
      totals.checked += 1;
      const { failed, manualFailed, manualTried, rateLimited } =
        await applyPayoutSetup(db, input.provider, account, input.log);
      // A business's account (release 2) has no person's page to refresh.
      if (manualTried && !manualFailed && account.profileId !== null)
        changed.add(account.profileId);
      totals.failed += failed;
      if (manualFailed) inARow += 1;
      else if (manualTried) inARow = 0;
      accountsLimitedInARow = rateLimited ? accountsLimitedInARow + 1 : 0;
      if (accountsLimitedInARow >= PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW) {
        stop('rate_limited');
        break accounts;
      }
      if (inARow >= limit) {
        stop('repeated_failures');
        break accounts;
      }
    }
    if (page.length < SWEEP_PAGE) break;
  }

  const pending: {
    id: string;
    profileId: string | null;
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
        ),
      )
      .orderBy(sql`random()`)
      .limit(input.maxDestinationReads ?? PAYOUT_SWEEP_MAX_DESTINATION_READS),
  );
  let limitedInARow = 0;
  for (const row of pending) {
    // A business's destination (R2-B) is not this sweep's: skip it, never stop the sweep.
    if (row.profileId === null) continue;
    let limited = false;
    if (
      await refreshPendingDestination(db, input.provider, {
        profileId: row.profileId,
        accountReference: row.accountReference,
        log: input.log,
        onReadFailure: (error) => {
          totals.destinationReadsFailed += 1;
          limited = isRateLimited(error);
        },
      })
    ) {
      totals.destinationsSettled += 1;
      changed.add(row.profileId);
    }
    limitedInARow = limited ? limitedInARow + 1 : 0;
    if (limitedInARow >= PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW) {
      totals.destinationReadsStopped = true;
      input.log?.({
        event: 'payout_setup.destination_reads_stopped',
        provider: 'bachs',
        error: 'rate_limited',
      });
      break;
    }
  }
  return { ...totals, changedProfileIds: [...changed] };
}
