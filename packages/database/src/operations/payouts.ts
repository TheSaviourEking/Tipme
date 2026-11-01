import { createHash } from 'node:crypto';
import {
  FEE_POLICY_V1,
  buildPayoutFeePosting,
  buildPayoutPosting,
  canTransition,
  formatMinor,
  PAYOUT_TRANSITIONS,
} from '@tipme/domain';
import type { PayoutStatus } from '@tipme/domain';
import {
  bachsEnvironment,
  PAYOUT_START_EVENT,
  recordedProviderName,
} from '@tipme/contracts';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issues,
  paymentAccounts,
  paymentAttempts,
  paymentIntents,
  payoutDestinations,
  payoutItems,
  payouts,
  profiles,
  providerEvents,
  providerFeeCredits,
  tipQuotes,
  tips,
  withdrawalHolds,
} from '../schema.js';
import { balanceIn } from './balance.js';
import { guarded, OperationError, safeError } from './errors.js';
import { recordAudit } from './audit.js';
import {
  withdrawalsSwitchedOff,
  withdrawalsSwitchState,
} from './withdrawals-switch.js';
import { openIssue } from './issues.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { jsonSafe } from './provider-events.js';
import { recordTransition } from './transitions.js';

export interface PayoutResult {
  payoutId: string;
  amountMinor: bigint;
  currency: string;
  replayed: boolean;
}

/**
 * Requests a payout of the recipient's net for succeeded tips. Each tip can be in only one active
 * payout (partial unique index); the idempotency key makes retries return the original payout.
 */
export async function createPayout(
  db: Database,
  input: {
    profileId: string;
    tipIds: string[];
    idempotencyKey: string;
    traceId?: string | null;
  },
): Promise<PayoutResult> {
  const traceId = input.traceId ?? activeTraceId();
  const ids = [...new Set(input.tipIds)].sort();
  // A reused key must describe the same request (same recipient, same tips) to replay.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.profileId, ids]))
    .digest('hex');
  return guarded(() =>
    db.transaction(async (tx) => {
      const replay = async (): Promise<PayoutResult | null> => {
        const [existing] = await tx
          .select()
          .from(payouts)
          .where(eq(payouts.idempotencyKey, input.idempotencyKey));
        if (!existing) return null;
        if (existing.requestFingerprint !== fingerprint)
          throw new OperationError('IDEMPOTENCY_CONFLICT');
        return {
          payoutId: existing.id,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          replayed: true,
        };
      };
      const earlier = await replay();
      if (earlier) return earlier;

      if (ids.length === 0) throw new OperationError('TIP_NOT_PAYABLE');
      const rows = await tx
        .select({
          id: tips.id,
          profileId: tips.profileId,
          status: tips.status,
          currency: tips.currency,
          net: tipQuotes.recipientNetMinor,
        })
        .from(tips)
        .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
        .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
        .where(inArray(tips.id, ids))
        .for('update', { of: tips });
      // The same request may have committed while this one waited for the tips' locks.
      const afterLock = await replay();
      if (afterLock) return afterLock;
      const claimed = await tx
        .select({ tipId: payoutItems.tipId })
        .from(payoutItems)
        .where(
          and(inArray(payoutItems.tipId, ids), eq(payoutItems.active, true)),
        );
      if (
        rows.length !== ids.length ||
        claimed.length > 0 ||
        rows.some(
          (row) =>
            row.profileId !== input.profileId || row.status !== 'SUCCEEDED',
        )
      ) {
        throw new OperationError('TIP_NOT_PAYABLE');
      }
      const currencies = new Set(rows.map((row) => row.currency));
      const [currency] = currencies;
      if (currencies.size !== 1 || !currency)
        throw new OperationError('CURRENCY_MISMATCH');
      const amountMinor = rows.reduce((sum, row) => sum + row.net, 0n);

      const payoutId = newId();
      const inserted = await tx
        .insert(payouts)
        .values({
          id: payoutId,
          profileId: input.profileId,
          currency,
          amountMinor,
          status: 'REQUESTED',
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
        })
        .onConflictDoNothing({ target: payouts.idempotencyKey })
        .returning({ id: payouts.id });
      if (inserted.length === 0) {
        const raced = await replay();
        if (raced) return raced;
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      await tx
        .insert(payoutItems)
        .values(ids.map((tipId) => ({ payoutId, tipId })));
      await recordTransition(tx, {
        entityType: 'payout',
        entityId: payoutId,
        fromStatus: null,
        toStatus: 'REQUESTED',
        cause: 'system',
        traceId,
      });
      return { payoutId, amountMinor, currency, replayed: false };
    }),
  );
}

/** Why a payout failed, as allowlisted by the payments package. */
export type PayoutFailure = 'in_debt' | 'destination' | 'other';

/** Pauses a recipient's withdrawals, once per issue. Requests check this under the profile lock. */
export async function holdWithdrawals(
  tx: Tx,
  input: {
    profileId: string;
    reason: 'reversal' | 'in_debt' | 'unexpected_payout' | 'account_takeover';
    issueId: string;
  },
): Promise<void> {
  // A redelivered cause finds its issue closed: staff already settled it, and nothing would ever
  // release a hold placed now.
  const [issue] = await tx
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, input.issueId));
  if (issue?.status !== 'open') return;
  const [existing] = await tx
    .select({ id: withdrawalHolds.id })
    .from(withdrawalHolds)
    .where(
      and(
        eq(withdrawalHolds.issueId, input.issueId),
        isNull(withdrawalHolds.releasedAt),
      ),
    );
  if (existing) return;
  await tx.insert(withdrawalHolds).values({ id: newId(), ...input });
  // Each payout not yet started is a person's to decide from now on, and they need its issue to do
  // it: while withdrawals are switched off no job runs to raise it. The start job's own check is
  // what stops the money, including for a request that raced this.
  const unstarted = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(
        eq(payouts.profileId, input.profileId),
        eq(payouts.status, 'REQUESTED'),
        isNull(payouts.providerReference),
        isNull(payouts.startStep),
        isNull(payouts.startUncertainAt),
      ),
    );
  for (const payout of unstarted)
    await openIssue(tx, {
      dedupeKey: `payout_held.${payout.id}`,
      kind: 'payout_held',
      subject: { payoutId: payout.id },
      now: new Date(),
    });
}

/**
 * Staff freeze a recipient's withdrawals after a reported account takeover, from the Pages screen.
 * Audited with the written reason, which stays out of the issue's summary and the recipient's view.
 * It stops money leaving and moves none: a payout already with the provider isn't recalled. It ends
 * the way every hold does, when the last of the recipient's money issues closes. Under the profile
 * lock, so a second report finds the first.
 */
export function freezeWithdrawals(
  db: Database,
  input: {
    profileId: string;
    staffUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ state: 'frozen' | 'already_frozen'; issueId: string }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!profile) throw new OperationError('PROFILE_NOT_FOUND');
      const [existing] = await tx
        .select({ issueId: withdrawalHolds.issueId })
        .from(withdrawalHolds)
        .where(
          and(
            eq(withdrawalHolds.profileId, input.profileId),
            eq(withdrawalHolds.reason, 'account_takeover'),
            isNull(withdrawalHolds.releasedAt),
          ),
        );
      if (existing) {
        // A second report: its written reason is evidence, though it changes nothing else.
        await recordAudit(tx, {
          staffUserId: input.staffUserId,
          action: 'withdrawals.freeze_reported_again',
          permission: 'payouts.resolve',
          subjectType: 'profile',
          subjectId: input.profileId,
          reason: input.reason,
          now,
        });
        return { state: 'already_frozen' as const, issueId: existing.issueId };
      }
      const issue = await openIssue(tx, {
        // A takeover can be reported again after the last one closed.
        dedupeKey: `account_takeover.${input.profileId}.${newId()}`,
        kind: 'account_takeover_reported',
        subject: { profileId: input.profileId },
        now,
      });
      await holdWithdrawals(tx, {
        profileId: input.profileId,
        reason: 'account_takeover',
        issueId: issue.id,
      });
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'withdrawals.frozen',
        permission: 'payouts.resolve',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
        now,
      });
      return { state: 'frozen' as const, issueId: issue.id };
    }),
  );
}

/** The issue holding this page's takeover freeze, or null when it isn't frozen. */
export function withdrawalFreezeIssue(
  db: Database | Tx,
  input: { profileId: string },
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ issueId: withdrawalHolds.issueId })
      .from(withdrawalHolds)
      .where(
        and(
          eq(withdrawalHolds.profileId, input.profileId),
          eq(withdrawalHolds.reason, 'account_takeover'),
          isNull(withdrawalHolds.releasedAt),
        ),
      );
    return row?.issueId ?? null;
  });
}

/** Whether a reported takeover has this page's withdrawals, and so its bank, frozen. */
export async function withdrawalsFrozen(
  db: Database | Tx,
  input: { profileId: string },
): Promise<boolean> {
  return (await withdrawalFreezeIssue(db, input)) !== null;
}

/**
 * The provider reports a refund or dispute on a paid tip: one issue per event for staff, and that
 * recipient's withdrawals wait. No balance or ledger entry changes (ADR-0004). The issue is opened
 * here, under the key the alert would give it, so the hold has one to name.
 */
export function flagPaymentReversal(
  db: Database,
  input: { attemptId: string; eventId: string; eventType: string; now?: Date },
): Promise<void> {
  // Dedupe keys allow word characters, dots and dashes only.
  const suffix = input.eventId.replace(/[^\w.-]/g, '_');
  return guarded(() =>
    db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        eventType: 'payment.reversed',
        aggregateId: input.attemptId,
        dedupeSuffix: suffix,
        payload: { attemptId: input.attemptId, eventType: input.eventType },
      });
      const issue = await openIssue(tx, {
        dedupeKey: `event.payment.reversed.${input.attemptId}.${suffix}`,
        kind: 'payment_reversed',
        subject: { attemptId: input.attemptId },
        now: input.now ?? new Date(),
      });
      const [tip] = await tx
        .select({ profileId: tips.profileId })
        .from(paymentAttempts)
        .innerJoin(tips, eq(tips.intentId, paymentAttempts.intentId))
        .where(eq(paymentAttempts.id, input.attemptId));
      if (tip)
        await holdWithdrawals(tx, {
          profileId: tip.profileId,
          reason: 'reversal',
          issueId: issue.id,
        });
    }),
  );
}

const openFeeShortIssue = (tx: Tx, payoutId: string, now: Date) =>
  openIssue(tx, {
    dedupeKey: `payout_fee_short.${payoutId}`,
    kind: 'payout_fee_short',
    subject: { payoutId },
    now,
  });

/**
 * The fee the provider actually charged becomes the payout's cost. Above what the top-up covered,
 * the difference came out of the recipient's money at the provider, so a person has to look.
 */
async function noteActualFee(
  tx: Tx,
  payout: { id: string; feeTransferReference: string | null },
  feeMinor: bigint,
  now: Date,
): Promise<void> {
  await tx.update(payouts).set({ feeMinor }).where(eq(payouts.id, payout.id));
  const [credit] = payout.feeTransferReference
    ? await tx
        .select({ amountMinor: providerFeeCredits.amountMinor })
        .from(providerFeeCredits)
        .where(
          eq(providerFeeCredits.transferReference, payout.feeTransferReference),
        )
    : [];
  if (feeMinor > (credit?.amountMinor ?? 0n))
    await openFeeShortIssue(tx, payout.id, now);
}

/** Records the fee an answer from the provider reported. Only a payout through an account has one. */
export function recordPayoutFee(
  db: Database,
  input: { payoutId: string; feeMinor: bigint; now: Date },
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [payout] = await tx
        .select()
        .from(payouts)
        .where(eq(payouts.id, input.payoutId))
        .for('update');
      if (
        !payout?.accountReference ||
        (payout.status !== 'REQUESTED' && payout.status !== 'PROCESSING')
      )
        return;
      await noteActualFee(tx, payout, input.feeMinor, input.now);
    }),
  );
}

/** Whether the provider itself is checking this payout, which the recipient is told. */
export function setPayoutReview(
  db: Database,
  input: { payoutId: string; inReview: boolean; now: Date },
): Promise<void> {
  return guarded(async () => {
    await db
      .update(payouts)
      .set({
        providerReviewAt: input.inReview
          ? sql`COALESCE(${payouts.providerReviewAt}, ${input.now.toISOString()}::timestamptz)`
          : null,
      })
      .where(
        and(
          eq(payouts.id, input.payoutId),
          inArray(payouts.status, ['REQUESTED', 'PROCESSING']),
        ),
      );
  });
}

const STATUS: Record<'processing' | 'paid' | 'failed', PayoutStatus> = {
  processing: 'PROCESSING',
  paid: 'PAID',
  failed: 'FAILED',
};

/** What a payout's failure releases, whoever decided it: its tips, and the recipient is told. */
async function releaseFailedPayout(
  tx: Tx,
  payout: { id: string; profileId: string },
): Promise<void> {
  // Release the tips so they can be paid out again.
  await tx
    .update(payoutItems)
    .set({ active: false })
    .where(eq(payoutItems.payoutId, payout.id));
  await enqueueOutbox(tx, {
    eventType: 'payout.failed',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, profileId: payout.profileId },
  });
}

/**
 * A person, not the provider, decided this payout failed. So no provider event is written: the
 * provider said nothing to store, and only the audit row and a `staff` transition say what happened.
 * The caller holds the row lock and has checked what makes this safe.
 */
export async function failPayoutByStaff(
  tx: Tx,
  payout: { id: string; profileId: string; status: string },
): Promise<void> {
  await tx
    .update(payouts)
    .set({ status: 'FAILED', startUncertainAt: null })
    .where(eq(payouts.id, payout.id));
  await recordTransition(tx, {
    entityType: 'payout',
    entityId: payout.id,
    fromStatus: payout.status,
    toStatus: 'FAILED',
    cause: 'staff',
    traceId: activeTraceId(),
  });
  await releaseFailedPayout(tx, payout);
}

type PayoutOutcomeInput = {
  payoutId: string;
  provider: string;
  providerEventId: string;
  /** Null when the provider refused the payout, so there is none to refer to. */
  providerReference: string | null;
  outcome: 'processing' | 'paid' | 'failed';
  signatureVerified: true;
  payload: unknown;
  /** Why it failed, when the provider's answer says. A debt pauses withdrawals. */
  failureReason?: PayoutFailure;
  /** The fee the provider actually charged, when its answer says. */
  actualFeeMinor?: bigint;
  traceId?: string | null;
  now?: Date;
};
type PayoutOutcomeResult = {
  outcome: 'applied' | 'duplicate' | 'ignored' | 'conflict';
  payoutStatus: string;
};

/** Applies a verified provider message about a payout; `paid` settles the payable in the ledger. */
export function recordPayoutOutcome(
  db: Database,
  input: PayoutOutcomeInput,
): Promise<PayoutOutcomeResult> {
  return guarded(() =>
    db.transaction((tx) => recordPayoutOutcomeIn(tx, input)),
  );
}

async function recordPayoutOutcomeIn(
  tx: Tx,
  input: PayoutOutcomeInput,
): Promise<PayoutOutcomeResult> {
  const traceId = input.traceId ?? activeTraceId();
  // The stored name, whichever adapter (bachs-live, bachs-sandbox) reports it.
  const provider = recordedProviderName(input.provider);
  const [payout] = await tx
    .select()
    .from(payouts)
    .where(eq(payouts.id, input.payoutId))
    .for('update');
  if (!payout) throw new OperationError('PAYOUT_NOT_FOUND');
  const eventRowId = newId();
  const stored = await tx
    .insert(providerEvents)
    .values({
      id: eventRowId,
      provider,
      providerEventId: input.providerEventId,
      eventType: `payout.${input.outcome}`,
      signatureVerified: input.signatureVerified,
      payloadHash: createHash('sha256')
        .update(JSON.stringify(jsonSafe(input.payload)))
        .digest('hex'),
      payload: jsonSafe(input.payload),
      payoutId: payout.id,
    })
    .onConflictDoNothing({
      target: [providerEvents.provider, providerEvents.providerEventId],
    })
    .returning({ id: providerEvents.id });
  if (stored.length === 0)
    return { outcome: 'duplicate' as const, payoutStatus: payout.status };

  const to = STATUS[input.outcome];
  const finish = async (
    outcome: 'applied' | 'ignored' | 'conflict',
    status: string,
  ) => {
    await tx
      .update(providerEvents)
      .set({
        processedAt: input.now ?? new Date(),
        processingOutcome: outcome,
      })
      .where(eq(providerEvents.id, eventRowId));
    return { outcome, payoutStatus: status };
  };
  if (!canTransition(PAYOUT_TRANSITIONS, payout.status, to)) {
    if (to === 'PAID' && payout.status === 'FAILED') {
      // The provider says it paid after we recorded a failure (and released the tips):
      // money may really have reached the recipient. Flag it for operations.
      await enqueueOutbox(tx, {
        eventType: 'payout.conflict',
        aggregateId: payout.id,
        dedupeSuffix: eventRowId,
        payload: { payoutId: payout.id, profileId: payout.profileId },
      });
      return finish('conflict', payout.status);
    }
    return finish('ignored', payout.status);
  }

  const now = input.now ?? new Date();
  await tx
    .update(payouts)
    .set({
      status: to,
      provider,
      providerReference: input.providerReference ?? payout.providerReference,
      ...(to === 'PAID' ? { paidAt: now } : {}),
    })
    .where(eq(payouts.id, payout.id));
  await recordTransition(tx, {
    entityType: 'payout',
    entityId: payout.id,
    fromStatus: payout.status,
    toStatus: to,
    cause: 'provider_event',
    providerEventId: eventRowId,
    traceId,
  });
  if (
    to !== 'FAILED' &&
    payout.accountReference &&
    input.actualFeeMinor !== undefined
  )
    await noteActualFee(tx, payout, input.actualFeeMinor, now);
  if (to === 'PAID') {
    await postLedgerTransaction(tx, {
      operationType: 'payout',
      operationKey: `payout.${payout.id}`,
      currency: payout.currency,
      payoutId: payout.id,
      traceId,
      lines: buildPayoutPosting({
        amountMinor: payout.amountMinor,
        profileId: payout.profileId,
      }),
    });
    await enqueueOutbox(tx, {
      eventType: 'payout.paid',
      aggregateId: payout.id,
      payload: {
        payoutId: payout.id,
        profileId: payout.profileId,
        currency: payout.currency,
        amountMinor: formatMinor(payout.amountMinor),
      },
    });
    // A payout through an account costs TipMe the fee; the pretend provider has no such cost.
    const feeMinor = input.actualFeeMinor ?? payout.feeMinor ?? 0n;
    if (payout.accountReference && feeMinor > 0n) {
      await postLedgerTransaction(tx, {
        operationType: 'payout',
        operationKey: `payout-fee.${payout.id}`,
        currency: payout.currency,
        payoutId: payout.id,
        traceId,
        lines: buildPayoutFeePosting({ feeMinor }),
      });
      // The top-up is used up only now: a payout that fails leaves it for the next one.
      const spent = payout.feeTransferReference
        ? await tx
            .update(providerFeeCredits)
            .set({ usedByPayoutId: payout.id })
            .where(
              and(
                eq(
                  providerFeeCredits.transferReference,
                  payout.feeTransferReference,
                ),
                isNull(providerFeeCredits.usedByPayoutId),
              ),
            )
            .returning({ reference: providerFeeCredits.transferReference })
        : [];
      if (spent.length === 0) await openFeeShortIssue(tx, payout.id, now);
    }
  }
  if (to === 'FAILED') {
    await releaseFailedPayout(tx, payout);
    if (input.failureReason === 'in_debt') {
      const issue = await openIssue(tx, {
        dedupeKey: `provider_in_debt.${payout.id}`,
        kind: 'provider_in_debt',
        subject: { payoutId: payout.id },
        now,
      });
      await holdWithdrawals(tx, {
        profileId: payout.profileId,
        reason: 'in_debt',
        issueId: issue.id,
      });
    }
  }
  return finish('applied', to);
}

/**
 * What a withdrawal reads from the provider. The port's own shape, kept structural because
 * provider types stay in the payments package (ADR-0004). Starting the payout is the worker's job.
 */
export interface PayoutReader {
  name: string;
  /** `connectedAccounts: false` is the pretend provider, which has no account or bank to reach. */
  capabilities?: { connectedAccounts: boolean };
  payoutCapability(accountRef: string): Promise<{
    status: 'active' | 'restricted' | 'missing';
    requirementsDue: string[];
  }>;
  payoutBalance(
    accountRef: string,
    currency: 'NGN',
  ): Promise<{ availableMinor: bigint }>;
  quotePayoutFee(
    accountRef: string,
    amountMinor: bigint,
    currency: 'NGN',
  ): Promise<{ feeMinor: bigint; exact: boolean }>;
}

export type WithdrawalQuoteResult =
  | {
      state: 'ready';
      withdrawableMinor: bigint;
      ledgerMinor: bigint;
      providerMinor: bigint;
      feeMinor: bigint;
      destination: { bankName: string; last4: string };
    }
  | { state: 'setup_needed'; requirementsDue: string[]; onboardingUrl?: string }
  | { state: 'no_destination' }
  | { state: 'destination_pending' }
  | {
      state: 'paused';
      reason:
        | 'reversal'
        | 'in_debt'
        | 'unexpected_payout'
        | 'review'
        | 'switched_off';
    }
  | { state: 'provider_unavailable' };

// Money can only leave through the provider that collected it. A paid tip collected by any other
// provider sits where this one cannot reach it, so it blocks the withdrawal rather than paying it
// out twice. Attempts record the stored name ('bachs'), so the adapter's name is converted first.
async function collectedElsewhere(
  db: Pick<Database, 'execute'>,
  input: { profileId: string; provider: string },
): Promise<boolean> {
  const stored = recordedProviderName(input.provider);
  const foreign = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM tips t
        JOIN payment_attempts a ON a.intent_id = t.intent_id
       WHERE t.profile_id = ${input.profileId} AND t.status = 'SUCCEEDED'
         AND a.status = 'VERIFIED_SUCCEEDED' AND a.provider IS DISTINCT FROM ${stored}
    ) AS found`);
  return Boolean(foreign.rows[0]?.found);
}

/** Whether a withdrawal through `provider` can be requested at all, before an amount is chosen. */
export function withdrawalsAvailable(
  db: Database,
  input: { profileId: string; provider: string },
): Promise<boolean> {
  return guarded(async () => !(await collectedElsewhere(db, input)));
}

/** Where a withdrawal would go, from TipMe's own records; the provider is not asked here. */
async function payoutRoute(
  db: Database,
  input: { profileId: string; provider: PayoutReader },
): Promise<{
  /** Whether this provider pays through a connected account at all. */
  accountless: boolean;
  accountReference: string | null;
  /** The provider will no longer pay this account out by itself. */
  manualPayouts: boolean;
  destination: {
    id: string;
    bankName: string;
    last4: string;
    status: string;
  } | null;
}> {
  const stored = recordedProviderName(input.provider.name);
  const accountless = input.provider.capabilities?.connectedAccounts === false;
  const environment = bachsEnvironment(input.provider.name);
  const [account] =
    accountless || !environment
      ? []
      : await db
          .select({
            reference: paymentAccounts.providerAccountReference,
            manualPayoutsAt: paymentAccounts.manualPayoutsAt,
          })
          .from(paymentAccounts)
          .where(
            and(
              eq(paymentAccounts.profileId, input.profileId),
              eq(paymentAccounts.provider, stored),
              eq(paymentAccounts.environment, environment),
            ),
          );
  const [destination] = await db
    .select({
      id: payoutDestinations.id,
      bankName: payoutDestinations.bankName,
      last4: payoutDestinations.accountLast4,
      status: payoutDestinations.status,
    })
    .from(payoutDestinations)
    .where(
      and(
        eq(payoutDestinations.profileId, input.profileId),
        eq(payoutDestinations.provider, stored),
        isNull(payoutDestinations.replacedAt),
      ),
    );
  return {
    accountless,
    accountReference: account?.reference ?? null,
    manualPayouts: Boolean(account?.manualPayoutsAt),
    destination: destination ?? null,
  };
}

/** The refusal an unusable route means, or null when the route can carry a payout. */
function routeBlock(
  route: Awaited<ReturnType<typeof payoutRoute>>,
):
  | { state: 'setup_needed'; requirementsDue: string[] }
  | { state: 'no_destination' }
  | { state: 'destination_pending' }
  | null {
  if (!route.accountless && !route.accountReference)
    return { state: 'setup_needed', requirementsDue: [] };
  // Otherwise the provider could pay the balance out itself while a withdrawal also spends it.
  if (!route.accountless && !route.manualPayouts)
    return { state: 'setup_needed', requirementsDue: [] };
  if (route.destination?.status === 'pending_review')
    return { state: 'destination_pending' };
  if (route.destination?.status === 'rejected')
    return { state: 'no_destination' };
  if (!route.destination && !route.accountless)
    return { state: 'no_destination' };
  return null;
}

/** Told why a read failed, so wrong keys don't pass as an outage. Never carries account data. */
export type ProviderReadFailureLog = (
  failure: ReturnType<typeof safeError>,
) => void;

/**
 * Everything the provider must confirm for a payout. Any failed read is 'unavailable': a withdrawal
 * never falls back to the ledger alone, because the money leaves the provider's balance, not ours.
 * Never call this inside a transaction: it is network IO, and the profile lock must stay short.
 */
async function readProvider(
  provider: PayoutReader,
  accountRef: string,
  amountMinor: (availableMinor: bigint) => bigint,
  onReadFailure?: ProviderReadFailureLog,
): Promise<
  | { state: 'ok'; availableMinor: bigint; feeMinor: bigint }
  | { state: 'setup_needed'; requirementsDue: string[] }
  | { state: 'unavailable' }
> {
  try {
    const capability = await provider.payoutCapability(accountRef);
    if (capability.status !== 'active')
      return {
        state: 'setup_needed',
        requirementsDue: capability.requirementsDue,
      };
    const { availableMinor } = await provider.payoutBalance(accountRef, 'NGN');
    const { feeMinor } = await provider.quotePayoutFee(
      accountRef,
      amountMinor(availableMinor),
      'NGN',
    );
    return { state: 'ok', availableMinor, feeMinor };
  } catch (error) {
    onReadFailure?.(safeError(error));
    return { state: 'unavailable' };
  }
}

/**
 * Money queued for the worker has left the ledger's available balance but not yet the provider's,
 * so the provider's figure still includes it. Counting it again would promise the same money twice.
 */
async function queuedNotStarted(
  db: Pick<Database, 'select'>,
  profileId: string,
): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${payouts.amountMinor}), 0)`,
    })
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

const lower = (a: bigint, b: bigint) => (a < b ? a : b);
const notNegative = (a: bigint) => (a < 0n ? 0n : a);

async function activeHold(
  db: Pick<Database, 'select'>,
  profileId: string,
): Promise<'reversal' | 'in_debt' | 'unexpected_payout' | 'review' | null> {
  const [hold] = await db
    .select({ reason: withdrawalHolds.reason })
    .from(withdrawalHolds)
    .where(
      and(
        eq(withdrawalHolds.profileId, profileId),
        isNull(withdrawalHolds.releasedAt),
      ),
    )
    .orderBy(asc(withdrawalHolds.createdAt))
    .limit(1);
  if (!hold) return null;
  // Whoever holds the account may be the one who took it: a freeze never says what it is about.
  if (hold.reason === 'account_takeover') return 'review';
  return hold.reason as 'reversal' | 'in_debt' | 'unexpected_payout';
}

/** Whether the provider itself is checking one of the recipient's unfinished payouts. */
export function withdrawalInReview(
  db: Database,
  profileId: string,
): Promise<boolean> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.profileId, profileId),
          inArray(payouts.status, ['REQUESTED', 'PROCESSING']),
          isNotNull(payouts.providerReviewAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

/** What the recipient can withdraw right now and, if nothing, why. Never moves money. */
export async function withdrawalQuote(
  db: Database,
  input: {
    profileId: string;
    provider: PayoutReader;
    onReadFailure?: ProviderReadFailureLog;
  },
): Promise<WithdrawalQuoteResult> {
  if (await withdrawalsSwitchedOff(db))
    return { state: 'paused', reason: 'switched_off' };
  const { hold, route, foreign } = await guarded(async () => ({
    hold: await activeHold(db, input.profileId),
    route: await payoutRoute(db, input),
    foreign: await collectedElsewhere(db, {
      profileId: input.profileId,
      provider: input.provider.name,
    }),
  }));
  if (hold) return { state: 'paused', reason: hold };
  // A request would be refused, so the quote must not say otherwise. The states have no word for
  // money collected by another provider; the dashboard explains it from `withdrawalsAvailable`.
  if (foreign) return { state: 'provider_unavailable' };
  const block = routeBlock(route);
  if (block) return block;
  const { ledgerMinor, queuedMinor } = await guarded(async () => ({
    ledgerMinor: (await balanceIn(db, input.profileId)).availableMinor,
    queuedMinor: await queuedNotStarted(db, input.profileId),
  }));
  const read = await readProvider(
    input.provider,
    route.accountReference ?? input.profileId,
    (available) => notNegative(lower(ledgerMinor, available - queuedMinor)),
    input.onReadFailure,
  );
  if (read.state === 'unavailable') return { state: 'provider_unavailable' };
  if (read.state === 'setup_needed') return read;
  const providerMinor = notNegative(read.availableMinor - queuedMinor);
  return {
    state: 'ready',
    withdrawableMinor: notNegative(lower(ledgerMinor, providerMinor)),
    ledgerMinor,
    providerMinor,
    feeMinor: read.feeMinor,
    destination: route.destination
      ? { bankName: route.destination.bankName, last4: route.destination.last4 }
      : { bankName: 'Pretend bank', last4: '0000' },
  };
}

/**
 * A recipient withdraws any amount up to what both TipMe's ledger and the provider's balance allow
 * (PR-008). The provider is read first, outside any transaction; then the profile row is locked so
 * two withdrawals at once can never overdraw, and holds are checked under that lock so a concurrent
 * one is seen. Nothing is posted to the ledger until the provider confirms the payout as paid: until
 * then the amount is reserved, and a failed payout simply releases it. The provider is never asked
 * to move money here: the `payouts.start` job, committed with the payout, makes the worker do that.
 * A replay returns the original payout whatever has changed since, and queues nothing.
 */
export async function requestWithdrawal(
  db: Database,
  input: {
    profileId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    provider: PayoutReader;
    traceId?: string | null;
    onReadFailure?: ProviderReadFailureLog;
  },
): Promise<{
  payoutId: string;
  status: string;
  replayed: boolean;
}> {
  const traceId = input.traceId ?? activeTraceId();
  const route = await guarded(() => payoutRoute(db, input));
  const destinationId = route.destination?.id ?? null;
  // Not the bank account: a retry after a bank change replays the payout in flight, which keeps the
  // destination it recorded. The new account is for the next withdrawal.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        'withdrawal',
        input.profileId,
        input.amountMinor.toString(),
      ]),
    )
    .digest('hex');
  const replayIn = async (reader: Pick<Database, 'select'>) => {
    const [existing] = await reader
      .select()
      .from(payouts)
      .where(eq(payouts.idempotencyKey, input.idempotencyKey));
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint)
      throw new OperationError('IDEMPOTENCY_CONFLICT');
    return {
      payoutId: existing.id,
      status: existing.status as string,
      replayed: true,
    };
  };
  // Before any provider read: a retry must get its payout even when the provider is down.
  const earlier = await guarded(() => replayIn(db));
  if (earlier) return earlier;
  if (input.amountMinor <= 0n) throw new OperationError('INVALID_INPUT');
  // Before any provider read: while off nothing about this request needs one.
  if ((await withdrawalsSwitchState(db)).paused)
    throw new OperationError('WITHDRAWALS_SWITCHED_OFF');
  const providerName = input.provider.name;
  const isForeign = () =>
    collectedElsewhere(db, {
      profileId: input.profileId,
      provider: providerName,
    });
  if (await guarded(isForeign))
    throw new OperationError('WITHDRAWAL_UNAVAILABLE');
  const block = routeBlock(route);
  if (block?.state === 'setup_needed')
    throw new OperationError('PAYOUT_SETUP_NEEDED');
  if (block) throw new OperationError('PAYOUT_DESTINATION_NEEDED');
  const read = await readProvider(
    input.provider,
    route.accountReference ?? input.profileId,
    () => input.amountMinor,
    input.onReadFailure,
  );
  if (read.state === 'unavailable')
    throw new OperationError('PAYOUT_PROVIDER_UNAVAILABLE');
  if (read.state === 'setup_needed')
    throw new OperationError('PAYOUT_SETUP_NEEDED');

  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      const afterLock = await replayIn(tx);
      if (afterLock) return afterLock;
      // Under the lock too, and read for real: a switch that can't be read refuses here.
      if ((await withdrawalsSwitchState(tx)).paused)
        throw new OperationError('WITHDRAWALS_SWITCHED_OFF');
      if (await activeHold(tx, input.profileId))
        throw new OperationError('WITHDRAWALS_PAUSED');
      const { availableMinor } = await balanceIn(tx, input.profileId);
      const withdrawable = lower(
        availableMinor,
        notNegative(
          read.availableMinor - (await queuedNotStarted(tx, input.profileId)),
        ),
      );
      if (input.amountMinor > withdrawable)
        throw new OperationError('INSUFFICIENT_BALANCE');
      // ₦1,000 minimum (PR-012), except to take all that can be taken: nobody is left with money
      // they cannot withdraw, or an account they cannot close.
      if (
        input.amountMinor < FEE_POLICY_V1.minWithdrawalMinor &&
        input.amountMinor !== withdrawable
      )
        throw new OperationError('WITHDRAWAL_TOO_SMALL');
      if (
        await collectedElsewhere(tx, {
          profileId: input.profileId,
          provider: providerName,
        })
      )
        throw new OperationError('WITHDRAWAL_UNAVAILABLE');
      if (destinationId) {
        // Held until commit: a bank change waits, and the payout never records a replaced account.
        const [current] = await tx
          .select({ id: payoutDestinations.id })
          .from(payoutDestinations)
          .where(
            and(
              eq(payoutDestinations.id, destinationId),
              eq(payoutDestinations.status, 'usable'),
              isNull(payoutDestinations.replacedAt),
            ),
          )
          .for('share');
        if (!current) throw new OperationError('PAYOUT_DESTINATION_NEEDED');
      }
      const payoutId = newId();
      const inserted = await tx
        .insert(payouts)
        .values({
          id: payoutId,
          profileId: input.profileId,
          currency: 'NGN',
          amountMinor: input.amountMinor,
          status: 'REQUESTED',
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          provider: recordedProviderName(providerName),
          destinationId,
          feeMinor: read.feeMinor,
          accountReference: route.accountReference,
        })
        .onConflictDoNothing({ target: payouts.idempotencyKey })
        .returning({ id: payouts.id });
      if (inserted.length === 0) {
        const raced = await replayIn(tx);
        if (raced) return raced;
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      await recordTransition(tx, {
        entityType: 'payout',
        entityId: payoutId,
        fromStatus: null,
        toStatus: 'REQUESTED',
        cause: 'system',
        traceId,
      });
      await enqueueOutbox(tx, {
        eventType: PAYOUT_START_EVENT,
        aggregateId: payoutId,
        payload: { payoutId, profileId: input.profileId },
      });
      return { payoutId, status: 'REQUESTED', replayed: false };
    }),
  );
}
