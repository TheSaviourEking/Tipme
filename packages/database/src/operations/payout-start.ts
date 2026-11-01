import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  paymentAccounts,
  payoutDestinations,
  payouts,
  profiles,
  providerFeeCredits,
  withdrawalHolds,
} from '../schema.js';
import { markPayoutInitiated } from './attempts.js';
import { guarded } from './errors.js';
import { openIssue } from './issues.js';
import {
  holdWithdrawals,
  recordPayoutFee,
  recordPayoutOutcome,
  setPayoutReview,
  type PayoutFailure,
} from './payouts.js';

/**
 * How long "the provider has no such payout" stays no proof after a start with no answer. The
 * request may still be in flight, and a list may lag; the provider client gives up within a minute,
 * so half an hour is well past both. It matches when a payment nobody can find alerts staff.
 */
export const PAYOUT_NOT_FOUND_AFTER_MS = 30 * 60 * 1000;
/** How long a payout event with an unknown reference waits for its start to be recorded. */
export const PAYOUT_UNEXPECTED_AFTER_MS = 10 * 60 * 1000;
/**
 * How long a payout the provider accepted may stay unfinished, or unreadable, before staff are told.
 * Bank payouts finish within hours; a day leaves room for the provider's own review.
 */
export const PAYOUT_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the provider says a payout is. Anything left out isn't compared. */
export type PayoutClaims = {
  amountMinor?: bigint;
  currency?: string;
  destinationRef?: string;
  /** The reference TipMe set: its own payout id. */
  operationReference?: string;
};

export type PayoutStartLog = (entry: {
  event: string;
  payout_id: string;
  step?: string;
  error?: string;
  cause?: string;
  http_status?: number;
  provider_code?: string;
  transfer_ref?: string;
}) => void;

/** The name and allowlisted diagnostic only: an error's message may name an account. */
function safeError(error: unknown): {
  error: string;
  cause?: string;
  http_status?: number;
  provider_code?: string;
} {
  const diagnostic =
    error instanceof Error && 'diagnostic' in error
      ? (error.diagnostic as
          | { cause?: string; httpStatus?: number; providerCode?: string }
          | undefined)
      : undefined;
  return {
    error: error instanceof Error ? error.name : 'unknown',
    ...(diagnostic?.cause ? { cause: diagnostic.cause } : {}),
    ...(diagnostic?.httpStatus ? { http_status: diagnostic.httpStatus } : {}),
    ...(diagnostic?.providerCode
      ? { provider_code: diagnostic.providerCode }
      : {}),
  };
}

/** Which call an unknown start stopped at, for the staff issue. */
export function startStepNote(step: string | null): string {
  if (step === 'fee')
    return 'The last step tried was the fee top-up, so the payout itself was not sent; the top-up may have gone through.';
  if (step === 'payout')
    return 'The last step tried was the payout itself, so it may have reached the provider.';
  return 'No provider call was recorded as attempted.';
}

/** The one issue that says money may have gone wrong. Only a person closes it. */
export function openPayoutConflict(
  db: Database,
  input: {
    payoutId: string;
    why: 'two_references' | 'mismatch' | 'ambiguous';
    now: Date;
  },
): Promise<{ id: string; opened: boolean }> {
  const notes = {
    two_references:
      'It has two references for one payout, so the recipient may have been paid twice. The money stays reserved.',
    mismatch:
      'What it reports differs from what TipMe asked for (amount, currency, destination or reference). Nothing was booked and the money stays reserved.',
    ambiguous:
      'It has more than one payout with TipMe’s reference, so the recipient may have been paid twice. The money stays reserved.',
  };
  return guarded(() =>
    openIssue(db, {
      dedupeKey: `payout_conflict.${input.why}.${input.payoutId}`,
      kind: 'payout_conflict',
      subject: { payoutId: input.payoutId },
      note: notes[input.why],
      now: input.now,
    }),
  );
}

export const isAmbiguousLookup = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AmbiguousPayoutError';

/** Whether what the provider says differs from what TipMe asked for, in anything it says. */
async function disagrees(
  db: Database,
  payoutId: string,
  claims: PayoutClaims,
): Promise<boolean> {
  if (
    claims.amountMinor === undefined &&
    claims.currency === undefined &&
    claims.destinationRef === undefined &&
    claims.operationReference === undefined
  )
    return false;
  return guarded(async () => {
    const [row] = await db
      .select({
        amountMinor: payouts.amountMinor,
        currency: payouts.currency,
        destinationRef: payoutDestinations.destinationReference,
      })
      .from(payouts)
      .leftJoin(
        payoutDestinations,
        eq(payoutDestinations.id, payouts.destinationId),
      )
      .where(eq(payouts.id, payoutId));
    if (!row) return true;
    return (
      (claims.amountMinor !== undefined &&
        claims.amountMinor !== row.amountMinor) ||
      (claims.currency !== undefined && claims.currency !== row.currency) ||
      (claims.destinationRef !== undefined &&
        claims.destinationRef !== row.destinationRef) ||
      (claims.operationReference !== undefined &&
        claims.operationReference !== payoutId)
    );
  });
}

export type FoundPayout = {
  providerReference: string;
  status: 'paid' | 'failed' | 'pending' | 'review';
  failureReason?: PayoutFailure;
  feeMinor?: bigint;
} & PayoutClaims;

/** What starting a payout needs from a provider: the port's shape (ADR-0004). */
export interface PayoutStarter {
  /** `connectedAccounts: false` is the pretend provider, with no account, bank or fee to cover. */
  capabilities?: { connectedAccounts: boolean };
  coverPayoutFee(input: {
    accountRef: string;
    feeMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
  }): Promise<{ transferRef: string }>;
  initiatePayout(input: {
    payoutId: string;
    accountRef?: string;
    destinationRef?: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<{
    providerReference: string;
    status: 'pending' | 'processing' | 'review';
    feeMinor?: bigint;
  }>;
  findPayoutByReference(
    accountRef: string,
    payoutId: string,
  ): Promise<FoundPayout | null>;
  /** The pretend bank pays at once; a real provider has nothing like it. */
  settlePayout?(providerReference: string): Promise<void>;
}

export type PayoutStartOutcome =
  'started' | 'already' | 'uncertain' | 'failed' | 'held';

type Payout = typeof payouts.$inferSelect;

// PayoutRejectedError lives in the payments package, which this one does not depend on (ADR-0004).
function refusal(error: unknown): { failureReason: PayoutFailure } | null {
  return error instanceof Error &&
    error.name === 'PayoutRejectedError' &&
    'failureReason' in error
    ? { failureReason: error.failureReason as PayoutFailure }
    : null;
}

/**
 * An answer from the provider about a payout it has: recorded through the same steps wherever it
 * came from (the start's response, a lookup, a status read). `applied` says a final state was new.
 */
export async function applyFoundPayout(
  db: Database,
  payout: Pick<Payout, 'id' | 'provider'>,
  found: FoundPayout,
  now: Date,
): Promise<{ outcome: 'started' | 'failed' | 'uncertain'; applied: boolean }> {
  const provider = payout.provider ?? 'unknown';
  // Before anything is recorded: a payout that isn't what TipMe asked for is never adopted or booked.
  if (await disagrees(db, payout.id, found)) {
    await openPayoutConflict(db, {
      payoutId: payout.id,
      why: 'mismatch',
      now,
    });
    return { outcome: 'uncertain', applied: false };
  }
  const marked = await markPayoutInitiated(db, {
    payoutId: payout.id,
    provider,
    providerReference: found.providerReference,
  });
  if (marked === 'conflict' || marked === 'not_found') {
    // Two references for one payout: a person must look, and nothing may be released.
    await openPayoutConflict(db, {
      payoutId: payout.id,
      why: 'two_references',
      now,
    });
    return { outcome: 'uncertain', applied: false };
  }
  const common = {
    payoutId: payout.id,
    provider,
    providerReference: found.providerReference,
    signatureVerified: true as const,
    now,
    ...(found.feeMinor === undefined ? {} : { actualFeeMinor: found.feeMinor }),
  };
  if (found.status === 'paid' || found.status === 'failed') {
    const result = await recordPayoutOutcome(db, {
      ...common,
      providerEventId: `reconcile.${payout.id}.${found.status}`,
      outcome: found.status,
      payload: { source: 'reconciliation' },
      ...(found.failureReason ? { failureReason: found.failureReason } : {}),
    });
    return {
      outcome: found.status === 'paid' ? 'started' : 'failed',
      applied: result.outcome === 'applied',
    };
  }
  await recordPayoutOutcome(db, {
    ...common,
    providerEventId: `start.${payout.id}`,
    outcome: 'processing',
    payload: { source: 'start' },
  });
  if (found.feeMinor !== undefined)
    await recordPayoutFee(db, {
      payoutId: payout.id,
      feeMinor: found.feeMinor,
      now,
    });
  await setPayoutReview(db, {
    payoutId: payout.id,
    inReview: found.status === 'review',
    now,
  });
  return { outcome: 'started', applied: false };
}

type Claim =
  | { kind: 'done'; outcome: PayoutStartOutcome }
  | { kind: 'read'; payout: Payout; starter: PayoutStarter }
  | { kind: 'unroutable'; payout: Payout }
  | {
      kind: 'write';
      payout: Payout;
      starter: PayoutStarter;
      route: { accountRef: string; destinationRef: string } | null;
    };

async function claimStart(
  tx: Tx,
  input: {
    payoutId: string;
    provider: PayoutStarter | ((name: string) => PayoutStarter);
    now: Date;
  },
): Promise<Claim> {
  const [payout] = await tx
    .select()
    .from(payouts)
    .where(eq(payouts.id, input.payoutId))
    .for('update', { skipLocked: true });
  // Locked is another worker with this payout; a missing row has nothing to start.
  if (!payout || !payout.provider) return { kind: 'done', outcome: 'already' };
  if (payout.status !== 'REQUESTED' || payout.providerReference !== null)
    return { kind: 'done', outcome: 'already' };
  // Before the mark: a provider this copy cannot reach retries the job with nothing recorded.
  const starter =
    typeof input.provider === 'function'
      ? input.provider(payout.provider)
      : input.provider;
  // An earlier attempt may have reached the provider. Never send it again; only ask.
  if (payout.startUncertainAt) return { kind: 'read', payout, starter };

  const [hold] = await tx
    .select({ id: withdrawalHolds.id })
    .from(withdrawalHolds)
    .where(
      and(
        eq(withdrawalHolds.profileId, payout.profileId),
        isNull(withdrawalHolds.releasedAt),
      ),
    )
    .limit(1);
  if (hold) {
    await openIssue(tx, {
      dedupeKey: `payout_held.${payout.id}`,
      kind: 'payout_held',
      subject: { payoutId: payout.id },
      now: input.now,
    });
    return { kind: 'done', outcome: 'held' };
  }

  let route: { accountRef: string; destinationRef: string } | null = null;
  if (starter.capabilities?.connectedAccounts !== false) {
    const [destination] = payout.destinationId
      ? await tx
          .select({ reference: payoutDestinations.destinationReference })
          .from(payoutDestinations)
          .where(eq(payoutDestinations.id, payout.destinationId))
      : [];
    // Nothing can be sent, and nothing has been: a definite failure, though requests prevent it.
    if (!payout.accountReference || !destination || payout.currency !== 'NGN')
      return { kind: 'unroutable', payout };
    route = {
      accountRef: payout.accountReference,
      destinationRef: destination.reference,
    };
  }
  // Committed before anything leaves. A row lock held across the call would not do: a worker dying
  // after the provider accepted would roll back any record of it, and the redelivered job would
  // send again. A second worker now sees this mark and reads instead.
  await tx
    .update(payouts)
    .set({ startUncertainAt: input.now })
    .where(eq(payouts.id, payout.id));
  return { kind: 'write', payout, starter, route };
}

/**
 * Takes an unspent top-up for this account, if one is free. The profile lock makes two payouts
 * choose in turn. It is only spent once a payout is paid, so a failed payout leaves it for the next.
 */
function claimFeeCredit(
  db: Database,
  payout: Payout,
  accountRef: string,
  feeMinor: bigint,
): Promise<string | null> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, payout.profileId))
        .for('update');
      const [credit] = await tx
        .select({ reference: providerFeeCredits.transferReference })
        .from(providerFeeCredits)
        .where(
          and(
            eq(providerFeeCredits.accountReference, accountRef),
            eq(providerFeeCredits.provider, payout.provider ?? ''),
            eq(providerFeeCredits.currency, payout.currency),
            isNull(providerFeeCredits.usedByPayoutId),
            sql`${providerFeeCredits.amountMinor} >= ${feeMinor}`,
            sql`NOT EXISTS (
              SELECT 1 FROM payouts p
               WHERE p.fee_transfer_reference = ${providerFeeCredits.transferReference}
                 AND p.status IN ('REQUESTED', 'PROCESSING'))`,
          ),
        )
        .orderBy(asc(providerFeeCredits.createdAt))
        .limit(1);
      if (!credit) return null;
      await tx
        .update(payouts)
        .set({ feeTransferReference: credit.reference })
        .where(eq(payouts.id, payout.id));
      return credit.reference;
    }),
  );
}

function recordFeeTopUp(
  db: Database,
  payout: Payout,
  input: { accountRef: string; feeMinor: bigint; transferRef: string },
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(providerFeeCredits)
        .values({
          accountReference: input.accountRef,
          provider: payout.provider ?? '',
          currency: payout.currency,
          amountMinor: input.feeMinor,
          transferReference: input.transferRef,
          payoutId: payout.id,
        })
        .onConflictDoNothing();
      await tx
        .update(payouts)
        .set({ feeTransferReference: input.transferRef })
        .where(eq(payouts.id, payout.id));
    }),
  );
}

async function failStart(
  db: Database,
  payout: Payout,
  failureReason: PayoutFailure,
  now: Date,
): Promise<'failed'> {
  await recordPayoutOutcome(db, {
    payoutId: payout.id,
    provider: payout.provider ?? 'unknown',
    providerEventId: `start-refused.${payout.id}`,
    providerReference: null,
    outcome: 'failed',
    failureReason,
    signatureVerified: true,
    payload: { source: 'start' },
    now,
  });
  // A definite answer: the mark was only there in case none came.
  await guarded(() =>
    db
      .update(payouts)
      .set({ startUncertainAt: null })
      .where(eq(payouts.id, payout.id)),
  );
  return 'failed';
}

/**
 * Starts a requested payout: the fee top-up (unless the account holds a free one), then the payout,
 * each with its own stable key. The first attempt's answer decides: a refusal on it proves no money
 * moved and releases the reservation. No answer leaves the payout REQUESTED and uncertain; from then
 * on only a read may move it, here on a redelivered job or in reconciliation, and it is never sent
 * again by itself.
 */
export async function startPayout(
  db: Database,
  input: {
    payoutId: string;
    provider: PayoutStarter | ((name: string) => PayoutStarter);
    now?: Date;
    /** Told about what is swallowed here, so an unknown start can be traced. */
    log?: PayoutStartLog;
  },
): Promise<PayoutStartOutcome> {
  const now = input.now ?? new Date();
  const claim = await guarded(() =>
    db.transaction((tx) =>
      claimStart(tx, {
        payoutId: input.payoutId,
        provider: input.provider,
        now,
      }),
    ),
  );
  if (claim.kind === 'done') return claim.outcome;
  if (claim.kind === 'unroutable')
    return failStart(db, claim.payout, 'other', now);

  const { payout, starter } = claim;
  if (claim.kind === 'read') {
    let found: FoundPayout | null;
    try {
      found = await starter.findPayoutByReference(
        payout.accountReference ?? '',
        payout.id,
      );
    } catch (error) {
      if (isAmbiguousLookup(error))
        await openPayoutConflict(db, {
          payoutId: payout.id,
          why: 'ambiguous',
          now,
        });
      return 'uncertain';
    }
    if (!found) return 'uncertain';
    return (await applyFoundPayout(db, payout, found, now)).outcome;
  }

  const { route } = claim;
  const answer = await sendPayout(db, payout, starter, route, input.log);
  if (answer.kind === 'uncertain') return 'uncertain';
  if (answer.kind === 'refused')
    return failStart(db, payout, answer.failureReason, now);

  const started = {
    providerReference: answer.started.providerReference,
    status:
      answer.started.status === 'review'
        ? ('review' as const)
        : ('pending' as const),
    ...(route && answer.started.feeMinor !== undefined
      ? { feeMinor: answer.started.feeMinor }
      : {}),
  };
  const { outcome } = await applyFoundPayout(db, payout, started, now);
  if (outcome !== 'started') return outcome;
  // A definite answer: the mark was only there in case none came.
  await guarded(() =>
    db
      .update(payouts)
      .set({ startUncertainAt: null })
      .where(eq(payouts.id, payout.id)),
  );
  await starter.settlePayout?.(started.providerReference);
  return 'started';
}

const noteStep = (db: Database, payoutId: string, step: 'fee' | 'payout') =>
  guarded(() =>
    db.update(payouts).set({ startStep: step }).where(eq(payouts.id, payoutId)),
  );

async function sendPayout(
  db: Database,
  payout: Payout,
  starter: PayoutStarter,
  route: { accountRef: string; destinationRef: string } | null,
  log?: PayoutStartLog,
): Promise<
  | {
      kind: 'sent';
      started: Awaited<ReturnType<PayoutStarter['initiatePayout']>>;
    }
  | { kind: 'refused'; failureReason: PayoutFailure }
  | { kind: 'uncertain' }
> {
  let step: 'fee' | 'payout' = 'fee';
  try {
    if (route) await coverFee(db, payout, starter, route.accountRef, log);
    step = 'payout';
    await noteStep(db, payout.id, step);
    const started = await starter.initiatePayout({
      payoutId: payout.id,
      ...(route ?? {}),
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      idempotencyKey: `payout.${payout.id}`,
    });
    return { kind: 'sent', started };
  } catch (error) {
    const refused = refusal(error);
    if (refused) return { kind: 'refused', ...refused };
    // Anything else, even an error of our own, may have followed a request that left.
    log?.({
      event: 'payout.start_uncertain',
      payout_id: payout.id,
      step,
      ...safeError(error),
    });
    return { kind: 'uncertain' };
  }
}

async function coverFee(
  db: Database,
  payout: Payout,
  starter: PayoutStarter,
  accountRef: string,
  log?: PayoutStartLog,
): Promise<void> {
  const feeMinor = payout.feeMinor ?? 0n;
  if (payout.feeTransferReference || feeMinor <= 0n) return;
  if (await claimFeeCredit(db, payout, accountRef, feeMinor)) return;
  await noteStep(db, payout.id, 'fee');
  const { transferRef } = await starter.coverPayoutFee({
    accountRef,
    feeMinor,
    currency: 'NGN',
    idempotencyKey: `payout-fee.${payout.id}`,
  });
  try {
    await recordFeeTopUp(db, payout, { accountRef, feeMinor, transferRef });
  } catch (error) {
    // The money moved and only this line says so: without it a later top-up pays ₦50 twice.
    log?.({
      event: 'payout.fee_unrecorded',
      payout_id: payout.id,
      transfer_ref: transferRef,
      ...safeError(error),
    });
    throw error;
  }
}

/**
 * A signed payout event for a payout TipMe knows. A paid event that agrees with itself is applied;
 * a failed one (which documents no reason) or a contradiction only triggers a read, and what the
 * read says is what happens. No answer, or "not found", changes nothing: reconciliation keeps asking.
 */
export async function applyPayoutSignal(
  db: Database,
  input: {
    payoutId: string;
    providerReference: string;
    eventId: string;
    status: 'paid' | 'failed';
    contradicted: boolean;
    /** What the event itself says the payout is. */
    claims?: PayoutClaims;
    /** The fee the event states. */
    feeMinor?: bigint;
    reader: {
      fetchPayoutStatus?: (reference: string) => Promise<{
        status: 'paid' | 'failed' | 'pending' | 'review' | 'not_found';
        failureReason?: PayoutFailure;
        feeMinor?: bigint;
        amountMinor?: bigint;
        currency?: string;
        destinationRef?: string;
      }>;
    };
    payload: unknown;
    now: Date;
  },
): Promise<string> {
  const conflict = async () => {
    await openPayoutConflict(db, {
      payoutId: input.payoutId,
      why: 'mismatch',
      now: input.now,
    });
    return 'conflict';
  };
  if (await disagrees(db, input.payoutId, input.claims ?? {}))
    return conflict();
  let outcome: 'paid' | 'failed' = input.status;
  let details: { failureReason?: PayoutFailure; actualFeeMinor?: bigint } =
    input.feeMinor === undefined ? {} : { actualFeeMinor: input.feeMinor };
  if (input.status === 'failed' || input.contradicted) {
    if (!input.reader.fetchPayoutStatus) return 'unread';
    let read;
    try {
      read = await input.reader.fetchPayoutStatus(input.providerReference);
    } catch {
      return 'unread';
    }
    if (read.status === 'pending' || read.status === 'review') {
      await setPayoutReview(db, {
        payoutId: input.payoutId,
        inReview: read.status === 'review',
        now: input.now,
      });
      return 'pending';
    }
    if (read.status === 'not_found') return 'pending';
    if (await disagrees(db, input.payoutId, read)) return conflict();
    outcome = read.status;
    details = {
      ...(read.failureReason ? { failureReason: read.failureReason } : {}),
      ...(read.feeMinor === undefined ? {} : { actualFeeMinor: read.feeMinor }),
    };
  }
  const result = await recordPayoutOutcome(db, {
    payoutId: input.payoutId,
    provider: 'bachs',
    providerEventId: input.eventId,
    providerReference: input.providerReference,
    outcome,
    signatureVerified: true,
    payload: input.payload,
    now: input.now,
    ...details,
  });
  return result.outcome;
}

/**
 * Nobody asked for this payout: staff check it, and the recipient's withdrawals wait. Rechecked in
 * the opening transaction, because a start may have recorded it since the caller looked.
 */
export function openUnexpectedPayout(
  db: Database,
  input: {
    unmatchedId: string;
    accountReference: string;
    providerReference: string;
    /** The reference signed into the event, which may name a payout of ours. */
    operationReference: string | null;
    now: Date;
  },
): Promise<void> {
  const notFoundBefore = new Date(
    input.now.getTime() - PAYOUT_NOT_FOUND_AFTER_MS,
  );
  return guarded(() =>
    db.transaction(async (tx) => {
      const [account] = await tx
        .select({ profileId: paymentAccounts.profileId })
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.provider, 'bachs'),
            eq(
              paymentAccounts.providerAccountReference,
              input.accountReference,
            ),
          ),
        );
      if (!account) return;
      const [ours] = await tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(
          and(
            eq(payouts.accountReference, input.accountReference),
            sql`(${payouts.providerReference} = ${input.providerReference}
              OR ${payouts.id}::text = ${input.operationReference}
              OR (${payouts.status} = 'REQUESTED'
                  AND ${payouts.providerReference} IS NULL
                  AND ${payouts.startUncertainAt} > ${notFoundBefore.toISOString()}::timestamptz))`,
          ),
        )
        .limit(1);
      if (ours) return;
      const issue = await openIssue(tx, {
        dedupeKey: `payout_unexpected.${input.unmatchedId}`,
        kind: 'payout_unexpected',
        subject: {
          profileId: account.profileId,
          unmatchedId: input.unmatchedId,
        },
        now: input.now,
      });
      await holdWithdrawals(tx, {
        profileId: account.profileId,
        reason: 'unexpected_payout',
        issueId: issue.id,
      });
    }),
  );
}
