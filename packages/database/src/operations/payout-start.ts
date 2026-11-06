import { PAYOUT_START_EVENT, PLATFORM_REFUSAL_EVENT } from '@tipme/contracts';
import { and, asc, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  issues,
  paymentAccounts,
  payoutDestinations,
  payouts,
  profiles,
  providerFeeCredits,
  withdrawalHolds,
} from '../schema.js';
import { markPayoutInitiated } from './attempts.js';
import { guarded, safeError } from './errors.js';
import { newId } from './ids.js';
import { enqueueOutbox } from './outbox.js';
import { withdrawalsSwitchState } from './withdrawals-switch.js';
import { openIssue } from './issues.js';
import {
  holdsOf,
  holdWithdrawals,
  recordPayoutFee,
  recordPayoutOutcome,
  setPayoutReview,
  type PayoutFailure,
} from './payouts.js';
import { ownerOf, personOf } from './owner.js';

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
    /** The fields that differ, by name only. */
    fields?: string[];
    now: Date;
  },
): Promise<{ id: string; opened: boolean }> {
  const notes = {
    two_references:
      'It has two references for one payout, so the recipient may have been paid twice. The money stays reserved.',
    mismatch: `What it reports differs from what TipMe asked for (${input.fields?.join(', ') ?? 'details'}). Nothing was booked and the money stays reserved.`,
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

/** The fields, by name, where what the provider says differs from what TipMe asked for. */
export async function differences(
  db: Database,
  payoutId: string,
  claims: PayoutClaims,
): Promise<string[]> {
  if (
    claims.amountMinor === undefined &&
    claims.currency === undefined &&
    claims.destinationRef === undefined &&
    claims.operationReference === undefined
  )
    return [];
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
    if (!row) return ['payout'];
    return [
      ...(claims.amountMinor !== undefined &&
      claims.amountMinor !== row.amountMinor
        ? ['amount']
        : []),
      ...(claims.currency !== undefined && claims.currency !== row.currency
        ? ['currency']
        : []),
      ...(claims.destinationRef !== undefined &&
      claims.destinationRef !== row.destinationRef
        ? ['destination']
        : []),
      ...(claims.operationReference !== undefined &&
      claims.operationReference !== payoutId
        ? ['reference']
        : []),
    ];
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
  | 'started'
  | 'already'
  | 'uncertain'
  | 'failed'
  | 'held'
  | 'switched_off'
  | 'waiting_on_platform';

type Payout = typeof payouts.$inferSelect;

// PayoutRejectedError lives in the payments package, which this one does not depend on (ADR-0004).
function refusal(error: unknown): { failureReason: PayoutFailure } | null {
  return error instanceof Error &&
    error.name === 'PayoutRejectedError' &&
    'failureReason' in error
    ? { failureReason: error.failureReason as PayoutFailure }
    : null;
}

// PlatformRefusalError lives there too. Only that error says so: a timeout is never one.
function platformRefusal(error: unknown): PlatformRefusal | null {
  return error instanceof Error &&
    error.name === 'PlatformRefusalError' &&
    'refusal' in error
    ? (error.refusal as PlatformRefusal)
    : null;
}

type PlatformRefusal = 'reserve_empty' | 'provider_key';

/**
 * One open issue and one alert per spell, however many withdrawals run into it. Each spell gets its
 * own key, since a closed issue must not swallow the next one.
 */
async function openPlatformRefusalIssue(
  tx: Tx,
  refusal: PlatformRefusal,
  now: Date,
): Promise<void> {
  const kind =
    refusal === 'reserve_empty' ? 'reserve_empty' : 'provider_key_refused';
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`platform_refusal:${kind}`}::text))`,
  );
  const [open] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.kind, kind), eq(issues.status, 'open')))
    .limit(1);
  if (open) return;
  const spell = newId();
  await openIssue(tx, {
    dedupeKey: `${kind}.${spell}`,
    kind,
    subject: {},
    now,
  });
  // The cause only: the alert route is a chat room.
  await enqueueOutbox(tx, {
    eventType: PLATFORM_REFUSAL_EVENT,
    aggregateId: spell,
    payload: { cause: refusal },
  });
}

/** The provider refused our key on some other call: staff hear of it the same way. */
export function reportProviderKeyRefused(
  db: Database,
  input: { now?: Date },
): Promise<void> {
  return guarded(() =>
    db.transaction((tx) =>
      openPlatformRefusalIssue(tx, 'provider_key', input.now ?? new Date()),
    ),
  );
}

/**
 * A definite refusal of TipMe itself: nothing moved, so the mark and step come off (nothing is in
 * doubt, and the money stays reserved) and the recipient hears nothing, since it isn't theirs to fix.
 */
function waitOnPlatform(
  db: Database,
  payout: Payout,
  refusal: PlatformRefusal,
  now: Date,
): Promise<'waiting_on_platform'> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .update(payouts)
        .set({
          startUncertainAt: null,
          startStep: null,
          platformWaitSince: now,
        })
        .where(and(eq(payouts.id, payout.id), eq(payouts.status, 'REQUESTED')));
      await openPlatformRefusalIssue(tx, refusal, now);
      return 'waiting_on_platform' as const;
    }),
  );
}

/**
 * Queues again what waits on the platform, once a reserve reading says it is funded. Only payouts
 * whose last try was a definite refusal: an attempt with no answer keeps its mark and is never sent
 * again. Those with an open issue are a person's to decide, and the job's own checks still apply.
 */
export function requeuePayoutsWaitingOnPlatform(
  db: Database,
): Promise<{ queued: number }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      if ((await withdrawalsSwitchState(tx)).paused) return { queued: 0 };
      const waiting = await tx
        .select({ id: payouts.id, profileId: payouts.profileId })
        .from(payouts)
        .where(
          and(
            eq(payouts.status, 'REQUESTED'),
            isNotNull(payouts.platformWaitSince),
            isNull(payouts.providerReference),
            isNull(payouts.startStep),
            isNull(payouts.startUncertainAt),
            sql`NOT EXISTS (
              SELECT 1 FROM issues i
               WHERE i.status = 'open'
                 AND i.subject->>'payoutId' = ${payouts.id}::text)`,
          ),
        )
        .limit(500);
      for (const payout of waiting)
        await enqueueOutbox(tx, {
          eventType: PAYOUT_START_EVENT,
          aggregateId: payout.id,
          dedupeSuffix: `platform.${newId()}`,
          payload: { payoutId: payout.id, profileId: payout.profileId },
        });
      return { queued: waiting.length };
    }),
  );
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
  const differing = await differences(db, payout.id, found);
  if (differing.length > 0) {
    await openPayoutConflict(db, {
      payoutId: payout.id,
      why: 'mismatch',
      fields: differing,
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

  // Any hold in force since this was requested, even one since released: a release clears the
  // account for new withdrawals, not for one a thief may have queued before it. It takes a person,
  // whose Resume counts for the holds that ended before it. Asked before the switch, so a job that
  // runs while off still raises the issue.
  const [hold] = await tx
    .select({ id: withdrawalHolds.id })
    .from(withdrawalHolds)
    .where(
      and(
        // A business's: its owners' takeover holds, owners when it was requested included (R2-B).
        holdsOf(ownerOf(payout), payout.createdAt),
        or(
          isNull(withdrawalHolds.releasedAt),
          gte(withdrawalHolds.createdAt, payout.createdAt),
          gte(withdrawalHolds.releasedAt, payout.createdAt),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM audit_events a
           WHERE a.action = 'payout.staff_resumed'
             AND a.subject_type = 'payout'
             AND a.subject_id = ${payout.id}
             AND a.created_at >= ${withdrawalHolds.releasedAt})`,
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

  // Off: it stays queued and reserved, with no failure, and is queued again when switched on. A
  // read that fails throws, so the job retries and nothing leaves on a guess.
  if ((await withdrawalsSwitchState(tx)).paused)
    return { kind: 'done', outcome: 'switched_off' };

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
      // The lock a withdrawal takes: the person's profile, or the business (R2-B).
      if (payout.businessId !== null)
        await tx
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.id, payout.businessId))
          .for('update');
      else
        await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.id, personOf(payout.profileId)))
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
  if (answer.kind === 'platform')
    return waitOnPlatform(db, payout, answer.refusal, now);
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

/**
 * Noted before the call it names. It only takes on a payout still waiting: staff may have marked a
 * start that stalled as failed, and then nothing may leave.
 */
async function noteStep(
  db: Database,
  payoutId: string,
  step: 'fee' | 'payout',
): Promise<void> {
  const noted = await guarded(() =>
    db
      .update(payouts)
      .set({ startStep: step })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, 'REQUESTED')))
      .returning({ id: payouts.id }),
  );
  if (noted.length === 0) throw new Error('payout_no_longer_requested');
}

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
  | { kind: 'platform'; refusal: PlatformRefusal }
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
    const platform = platformRefusal(error);
    if (platform) return { kind: 'platform', refusal: platform };
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
    // A new key only after a definite refusal, which moved nothing and may replay under the old one.
    // An attempt with no answer never gets here again.
    idempotencyKey: payout.platformWaitSince
      ? `payout-fee.${payout.id}.r${payout.platformWaitSince.getTime()}`
      : `payout-fee.${payout.id}`,
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
 * a failed one (which documents no reason), a contradiction or one that differs from the request
 * only triggers a read, and what the
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
        operationReference?: string;
      }>;
    };
    payload: unknown;
    now: Date;
  },
): Promise<string> {
  // The docs don't settle whether an event's amount includes the fee, so an event that differs is
  // only a contradiction: a read decides, and only a read that differs is a conflict.
  const eventDiffering = await differences(
    db,
    input.payoutId,
    input.claims ?? {},
  );
  const eventDiffers = eventDiffering.length > 0;
  let outcome: 'paid' | 'failed' = input.status;
  let details: { failureReason?: PayoutFailure; actualFeeMinor?: bigint } =
    input.feeMinor === undefined ? {} : { actualFeeMinor: input.feeMinor };
  if (input.status === 'failed' || input.contradicted || eventDiffers) {
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
    const differing = await differences(db, input.payoutId, read);
    if (differing.length > 0) {
      await openPayoutConflict(db, {
        payoutId: input.payoutId,
        why: 'mismatch',
        fields: differing,
        now: input.now,
      });
      return 'conflict';
    }
    // An event that differs needs a read that positively says otherwise, not a silent one.
    if (eventDiffers && read.amountMinor === undefined) return 'unread';
    if (
      eventDiffering.includes('reference') &&
      read.operationReference === undefined
    )
      return 'unread';
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

/** A parked event names a payout it can't belong to: possibly paid after release, or paid twice. */
export function openParkedPayoutConflict(
  db: Database,
  input: { unmatchedId: string; payoutId: string; now: Date },
): Promise<{ id: string; opened: boolean }> {
  return guarded(() =>
    openIssue(db, {
      dedupeKey: `payout_conflict.parked.${input.unmatchedId}`,
      kind: 'payout_conflict',
      subject: { payoutId: input.payoutId, unmatchedId: input.unmatchedId },
      note: 'It sent a signed payout event naming this withdrawal, which already ended or has another reference. Money may have left: check it at the provider.',
      now: input.now,
    }),
  );
}

/** A parked event has had no answer for too long: a person looks. */
export function openParkedPayoutUnresolved(
  db: Database,
  input: { unmatchedId: string; payoutId: string; now: Date },
): Promise<{ id: string; opened: boolean }> {
  return guarded(() =>
    openIssue(db, {
      dedupeKey: `payout_parked.${input.unmatchedId}`,
      kind: 'payout_unresolved',
      subject: { payoutId: input.payoutId, unmatchedId: input.unmatchedId },
      note: 'A signed payout event about it could not be applied, because the provider’s record has given no usable answer.',
      now: input.now,
    }),
  );
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
          profileId: account.profileId ?? undefined,
          unmatchedId: input.unmatchedId,
        },
        now: input.now,
      });
      // R2-B creates no business payment account, so none is met here; were one, the issue still
      // opens, and a business has no holds of its own (that needs a migration).
      if (account.profileId !== null)
        await holdWithdrawals(tx, {
          profileId: account.profileId,
          reason: 'unexpected_payout',
          issueId: issue.id,
        });
    }),
  );
}
