import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { issues, paymentAccounts, profiles, users } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { recordAudit } from './audit.js';
import { OPAQUE_PROVIDER_ID } from './provider-ids.js';

export type PaymentAccountStatus =
  (typeof paymentAccounts.$inferSelect)['status'];
export type PaymentAccountEnvironment =
  (typeof paymentAccounts.$inferSelect)['environment'];
export type PaymentAccountSummary = Pick<
  typeof paymentAccounts.$inferSelect,
  | 'id'
  | 'provider'
  | 'environment'
  | 'providerAccountReference'
  | 'status'
  | 'chargesEnabled'
  | 'payoutsEnabled'
  | 'feeCollector'
  | 'requirementsDue'
  | 'lastSyncedAt'
>;

/** Operator-safe account state; never returns the recipient's private email. */
export function getBachsAccountRecoveryTarget(
  db: Database,
  profileId: string,
): Promise<{
  status: PaymentAccountStatus;
  providerAccountReference: string | null;
  emailVerified: boolean;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        status: paymentAccounts.status,
        providerAccountReference: paymentAccounts.providerAccountReference,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(paymentAccounts)
      .innerJoin(profiles, eq(profiles.id, paymentAccounts.profileId))
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(paymentAccounts.profileId, profileId),
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.environment, 'sandbox'),
        ),
      );
    return row
      ? {
          status: row.status,
          providerAccountReference: row.providerAccountReference,
          emailVerified: row.emailVerifiedAt !== null,
        }
      : null;
  });
}

export function getPaymentAccountRecipient(
  db: Database,
  userId: string,
): Promise<{
  profileId: string;
  displayName: string;
  verifiedEmail: string | null;
} | null> {
  return guarded(async () => {
    const [recipient] = await db
      .select({
        profileId: profiles.id,
        pageState: profiles.pageState,
        status: profiles.status,
        displayName: profiles.displayName,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(eq(users.id, userId));
    if (!recipient || recipient.pageState === 'deleted') return null;
    if (recipient.status !== 'active')
      throw new OperationError('PAGE_SUSPENDED');
    return {
      profileId: recipient.profileId,
      displayName: recipient.displayName,
      verifiedEmail: recipient.emailVerifiedAt ? recipient.email : null,
    };
  });
}

const FEE_COLLECTORS = new Set(['platform', 'connected_account', 'unknown']);

/** Creates exactly one account-creation claim for a profile/provider/environment. */
export function beginPaymentAccountCreation(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
    now?: Date;
  },
): Promise<{ created: boolean; account: PaymentAccountSummary }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ status: profiles.status, pageState: profiles.pageState })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!profile || profile.pageState === 'deleted')
        throw new OperationError('NO_PAGE');
      if (profile.status !== 'active')
        throw new OperationError('PAGE_SUSPENDED');

      const [existing] = await tx
        .select()
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.profileId, input.profileId),
            eq(paymentAccounts.provider, input.provider),
            eq(paymentAccounts.environment, input.environment),
          ),
        )
        .for('update');
      if (existing) {
        if (existing.status !== 'FAILED')
          return { created: false, account: summarize(existing) };
        const [restarted] = await tx
          .update(paymentAccounts)
          .set({
            status: 'CREATING',
            providerAccountReference: null,
            chargesEnabled: false,
            payoutsEnabled: false,
            feeCollector: 'unknown',
            requirementsDue: [],
            lastSyncedAt: null,
            updatedAt: now,
          })
          .where(eq(paymentAccounts.id, existing.id))
          .returning();
        if (!restarted) throw new OperationError('INVALID_INPUT');
        return { created: true, account: summarize(restarted) };
      }

      const [account] = await tx
        .insert(paymentAccounts)
        .values({
          id: newId(),
          profileId: input.profileId,
          provider: input.provider,
          environment: input.environment,
          status: 'CREATING',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!account) throw new OperationError('INVALID_INPUT');
      return { created: true, account: summarize(account) };
    }),
  );
}

/**
 * Stores only normalized provider account state. External references are immutable after their
 * first successful write; a conflicting reference cannot silently remap a recipient.
 */
export function updatePaymentAccountStatus(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
    providerAccountReference: string;
    status: Exclude<PaymentAccountStatus, 'CREATING' | 'UNKNOWN' | 'FAILED'>;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    feeCollector: 'platform' | 'connected_account' | 'unknown';
    requirementsDue: string[];
    now?: Date;
  },
): Promise<PaymentAccountSummary> {
  const now = input.now ?? new Date();
  if (
    input.providerAccountReference.trim() === '' ||
    input.requirementsDue.length > 50 ||
    input.requirementsDue.some(
      (requirement) =>
        requirement.trim() === '' ||
        requirement.length > 100 ||
        /[\r\n]/.test(requirement),
    ) ||
    !FEE_COLLECTORS.has(input.feeCollector) ||
    (input.status === 'ACTIVE' && !input.chargesEnabled)
  ) {
    return Promise.reject(new OperationError('INVALID_INPUT'));
  }

  return guarded(() =>
    db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.profileId, input.profileId),
            eq(paymentAccounts.provider, input.provider),
            eq(paymentAccounts.environment, input.environment),
          ),
        )
        .for('update');
      if (!account) throw new OperationError('NO_PAGE');
      if (
        account.status === 'UNKNOWN' &&
        account.providerAccountReference === null
      ) {
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      if (
        account.providerAccountReference !== null &&
        account.providerAccountReference !== input.providerAccountReference
      ) {
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      const [updated] = await tx
        .update(paymentAccounts)
        .set({
          providerAccountReference: input.providerAccountReference,
          status: input.status,
          chargesEnabled: input.chargesEnabled,
          payoutsEnabled: input.payoutsEnabled,
          feeCollector: input.feeCollector,
          requirementsDue: [...input.requirementsDue],
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(paymentAccounts.id, account.id))
        .returning();
      if (!updated) throw new OperationError('NO_PAGE');
      return summarize(updated);
    }),
  );
}

/** Links a dashboard-found account only to a still-unknown sandbox creation, with an audit row. */
export function recoverUnknownPaymentAccount(
  db: Database,
  input: {
    issueId: string;
    profileId: string;
    providerAccountReference: string;
    status: 'ONBOARDING' | 'ACTIVE' | 'RESTRICTED';
    chargesEnabled: boolean;
    feeCollector: 'platform' | 'connected_account' | 'unknown';
    requirementsDue: string[];
    dashboardVerified: true;
    staffUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<PaymentAccountSummary> {
  const now = input.now ?? new Date();
  if (
    !OPAQUE_PROVIDER_ID.test(input.providerAccountReference) ||
    input.requirementsDue.length > 50 ||
    input.requirementsDue.some(
      (requirement) =>
        requirement.trim() === '' ||
        requirement.length > 100 ||
        /[\r\n]/.test(requirement),
    ) ||
    !FEE_COLLECTORS.has(input.feeCollector) ||
    (input.status === 'ACTIVE') !== input.chargesEnabled ||
    input.dashboardVerified !== true ||
    input.reason.trim().length < 10
  ) {
    return Promise.reject(new OperationError('INVALID_INPUT'));
  }

  return guarded(() =>
    db.transaction(async (tx) => {
      const [recipient] = await tx
        .select({ emailVerifiedAt: users.emailVerifiedAt })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!recipient?.emailVerifiedAt)
        throw new OperationError('EMAIL_VERIFICATION_REQUIRED');

      const [issue] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.kind, 'payment_account_unresolved'),
            eq(issues.status, 'open'),
            sql`${issues.subject}->>'profileId' = ${input.profileId}`,
          ),
        )
        .for('update');
      if (!issue) throw new OperationError('ISSUE_RESOLVED');

      const [account] = await tx
        .select()
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.profileId, input.profileId),
            eq(paymentAccounts.provider, 'bachs'),
            eq(paymentAccounts.environment, 'sandbox'),
            eq(paymentAccounts.status, 'UNKNOWN'),
            isNull(paymentAccounts.providerAccountReference),
          ),
        )
        .for('update');
      if (!account) throw new OperationError('IDEMPOTENCY_CONFLICT');

      const [updated] = await tx
        .update(paymentAccounts)
        .set({
          providerAccountReference: input.providerAccountReference,
          status: input.status,
          chargesEnabled: input.chargesEnabled,
          payoutsEnabled: false,
          feeCollector: input.feeCollector,
          requirementsDue: [...input.requirementsDue],
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(paymentAccounts.id, account.id))
        .returning();
      if (!updated) throw new OperationError('IDEMPOTENCY_CONFLICT');
      await tx
        .update(issues)
        .set({
          status: 'resolved',
          resolvedAt: now,
          resolvedBy: input.staffUserId,
        })
        .where(eq(issues.id, issue.id));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'payment_account.recovered',
        permission: 'payments.recheck',
        subjectType: 'payment_account',
        subjectId: account.id,
        reason: `${input.reason} [dashboard identity and platform-fee settings checked; provider status fetched]`,
        now,
      });
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'issue.resolved',
        permission: 'payments.recheck',
        subjectType: 'issue',
        subjectId: issue.id,
        reason: `${input.reason} [Bachs recipient account status verified and linked]`,
        now,
      });
      return summarize(updated);
    }),
  );
}

/** A definite provider-side rejection is retryable; ambiguous creation is not. */
export function markPaymentAccountCreationFailed(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const updated = await db
      .update(paymentAccounts)
      .set({ status: 'FAILED', updatedAt: now })
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(paymentAccounts.provider, input.provider),
          eq(paymentAccounts.environment, input.environment),
          eq(paymentAccounts.status, 'CREATING'),
        ),
      )
      .returning({ id: paymentAccounts.id });
    return updated.length > 0;
  });
}

/** Preserves ambiguous account creation as a permanent hold; never permits a duplicate create. */
export function markPaymentAccountCreationUnknown(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const updated = await db
      .update(paymentAccounts)
      .set({ status: 'UNKNOWN', updatedAt: now })
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(paymentAccounts.provider, input.provider),
          eq(paymentAccounts.environment, input.environment),
          eq(paymentAccounts.status, 'CREATING'),
        ),
      )
      .returning({ id: paymentAccounts.id });
    return updated.length > 0;
  });
}

/** A process crash during account creation is unresolved, never an invitation to create again. */
export function expireStalePaymentAccountCreations(
  db: Database,
  input: { olderThan: Date; now: Date; limit?: number },
): Promise<number> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const stale = await tx
        .select({ id: paymentAccounts.id })
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.status, 'CREATING'),
            lte(paymentAccounts.updatedAt, input.olderThan),
          ),
        )
        .limit(input.limit ?? 100)
        .for('update');
      for (const account of stale) {
        await tx
          .update(paymentAccounts)
          .set({ status: 'UNKNOWN', updatedAt: input.now })
          .where(eq(paymentAccounts.id, account.id));
      }
      return stale.length;
    }),
  );
}

/** Provider references used by checkout stay server-side and are environment-scoped. */
export function getReadyPaymentAccount(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
  },
): Promise<string | null> {
  return guarded(async () => {
    const [account] = await db
      .select({
        reference: paymentAccounts.providerAccountReference,
        feeCollector: paymentAccounts.feeCollector,
      })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(paymentAccounts.provider, input.provider),
          eq(paymentAccounts.environment, input.environment),
          eq(paymentAccounts.status, 'ACTIVE'),
          eq(paymentAccounts.chargesEnabled, true),
        ),
      );
    return account?.feeCollector === 'platform' ? account.reference : null;
  });
}

/** Safe status lookup for an authenticated recipient; never returns the provider account ID. */
export function getPaymentAccountForProfile(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    environment: PaymentAccountEnvironment;
  },
): Promise<Omit<PaymentAccountSummary, 'providerAccountReference'> | null> {
  return guarded(async () => {
    const [account] = await db
      .select()
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(paymentAccounts.provider, input.provider),
          eq(paymentAccounts.environment, input.environment),
        ),
      );
    if (!account) return null;
    const summary = summarize(account);
    return {
      id: summary.id,
      provider: summary.provider,
      environment: summary.environment,
      status: summary.status,
      chargesEnabled: summary.chargesEnabled,
      payoutsEnabled: summary.payoutsEnabled,
      feeCollector: summary.feeCollector,
      requirementsDue: summary.requirementsDue,
      lastSyncedAt: summary.lastSyncedAt,
    };
  });
}

function summarize(account: typeof paymentAccounts.$inferSelect) {
  return {
    id: account.id,
    provider: account.provider,
    environment: account.environment,
    providerAccountReference: account.providerAccountReference,
    status: account.status,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    feeCollector: account.feeCollector,
    requirementsDue: account.requirementsDue,
    lastSyncedAt: account.lastSyncedAt,
  };
}

/** Which page a provider account belongs to, for refreshing it from the provider. */
export function findPaymentAccountByReference(
  db: Database,
  input: {
    provider: string;
    environment: PaymentAccountEnvironment;
    providerAccountReference: string;
  },
): Promise<{ profileId: string } | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ profileId: paymentAccounts.profileId })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.provider, input.provider),
          eq(paymentAccounts.environment, input.environment),
          eq(
            paymentAccounts.providerAccountReference,
            input.providerAccountReference,
          ),
        ),
      );
    return row ?? null;
  });
}
