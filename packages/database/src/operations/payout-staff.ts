import type {
  OpsPayoutActionResult,
  OpsPayoutIssueView,
} from '@tipme/contracts';
import { PAYOUT_START_EVENT } from '@tipme/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issues,
  payoutDestinations,
  payouts,
  unmatchedProviderEvents,
  withdrawalHolds,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError, safeError } from './errors.js';
import { newId } from './ids.js';
import { markResolved } from './issues.js';
import { enqueueOutbox } from './outbox.js';
import {
  applyFoundPayout,
  differences,
  isAmbiguousLookup,
  openPayoutConflict,
  PAYOUT_NOT_FOUND_AFTER_MS,
  type FoundPayout,
  type PayoutStartLog,
} from './payout-start.js';
import { recordPayoutOutcomeIn, type PayoutFailure } from './payouts.js';

/*
 * What staff can do about a withdrawal the system can't settle by itself (permission
 * `payouts.resolve`). Each action reads the provider first, here on the server, whatever the page
 * last showed, and acts only if that read still offers it. None sends a create or edits the ledger.
 * Each is one exported function, so a second-person approval can wrap it later.
 */

/** What a staff read needs from a provider: the port's shape (ADR-0004). */
export interface StaffPayoutReader {
  fetchPayoutStatus(providerReference: string): Promise<{
    status: 'paid' | 'failed' | 'pending' | 'review' | 'not_found';
    failureReason?: PayoutFailure;
    feeMinor?: bigint;
    amountMinor?: bigint;
    currency?: string;
    destinationRef?: string;
    operationReference?: string;
  }>;
  findPayoutByReference(
    accountRef: string,
    payoutId: string,
  ): Promise<FoundPayout | null>;
}

type StaffInput = {
  issueId: string;
  staffUserId: string;
  provider: (name: string) => StaffPayoutReader;
  now?: Date;
  /** Told why a read failed. Names and allowlisted diagnostics only. */
  log?: PayoutStartLog;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tail = (value: string | null | undefined) =>
  value ? value.slice(-6) : null;

type Case = NonNullable<Awaited<ReturnType<typeof loadCase>>>;

/** The issue, its payout and everything that decides what may be offered, read together. */
async function loadCase(db: Database | Tx, issueId: string) {
  if (!UUID.test(issueId)) return null;
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  if (
    !issue?.subject.payoutId ||
    !['payout_unresolved', 'payout_conflict', 'payout_held'].includes(
      issue.kind,
    )
  )
    return null;
  const payoutId = issue.subject.payoutId;
  const [payout] = await db
    .select()
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  if (!payout) return null;
  const [hold] = await db
    .select({ id: withdrawalHolds.id })
    .from(withdrawalHolds)
    .where(
      and(
        eq(withdrawalHolds.profileId, payout.profileId),
        isNull(withdrawalHolds.releasedAt),
      ),
    )
    .limit(1);
  const [parked] = await db
    .select({ id: unmatchedProviderEvents.id })
    .from(unmatchedProviderEvents)
    .where(
      and(
        eq(unmatchedProviderEvents.reason, 'unknown_payout'),
        sql`${unmatchedProviderEvents.payload}->>'operationReference' = ${payoutId}`,
      ),
    )
    .limit(1);
  const [conflict] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.status, 'open'),
        eq(issues.kind, 'payout_conflict'),
        sql`${issues.id} <> ${issue.id}`,
        sql`${issues.subject}->>'payoutId' = ${payoutId}`,
      ),
    )
    .limit(1);
  const [destination] = payout.destinationId
    ? await db
        .select({ replacedAt: payoutDestinations.replacedAt })
        .from(payoutDestinations)
        .where(eq(payoutDestinations.id, payout.destinationId))
    : [];
  return {
    issue,
    payout,
    holdActive: Boolean(hold),
    parkedEvent: Boolean(parked),
    openConflict: Boolean(conflict),
    destinationReplaced: Boolean(destination?.replacedAt),
  };
}

type Answer =
  | { state: 'absent' | 'uncertain' | 'ambiguous' | 'conflicting' }
  | {
      state: 'paid' | 'failed' | 'pending' | 'review';
      found: FoundPayout;
      differing: string[];
    };

/**
 * Asks the provider, by its own id if TipMe has one and by TipMe's id either way, because a failed
 * read of one reference must not release money while another payout with TipMe's id has been paid.
 * Only a lookup that definitely finds nothing, for a payout with no reference, counts as absent.
 */
async function askProvider(
  db: Database,
  payout: Case['payout'],
  input: StaffInput,
): Promise<Answer> {
  const { providerReference } = payout;
  try {
    if (!payout.provider) return { state: 'uncertain' };
    const reader = input.provider(payout.provider);
    const byId = await reader.findPayoutByReference(
      payout.accountReference ?? '',
      payout.id,
    );
    let found: FoundPayout | null = byId;
    if (providerReference) {
      if (byId && byId.providerReference !== providerReference)
        return { state: 'conflicting' };
      const { status, ...details } =
        await reader.fetchPayoutStatus(providerReference);
      // The provider accepted it once, so "no such payout" now is a puzzle, not an answer.
      if (status === 'not_found') return { state: 'uncertain' };
      found = { providerReference, status, ...details };
    }
    if (!found) return { state: 'absent' };
    return {
      state: found.status,
      found,
      differing: await differences(db, payout.id, found),
    };
  } catch (error) {
    if (isAmbiguousLookup(error)) return { state: 'ambiguous' };
    input.log?.({
      event: 'payout.staff_read_failed',
      payout_id: payout.id,
      ...safeError(error),
    });
    return { state: 'uncertain' };
  }
}

/** The whole rule for what is offered. The page and the actions both go by this. */
function offersFor(
  kase: Case,
  answer: Answer,
  now: Date,
): OpsPayoutIssueView['offers'] {
  const { issue, payout } = kase;
  const none = { applyReported: null, resume: false, markFailed: false };
  if (issue.status !== 'open') return none;
  const unfinished =
    payout.status === 'REQUESTED' || payout.status === 'PROCESSING';
  if (!unfinished) return none;
  if (answer.state === 'paid' || answer.state === 'failed')
    return {
      ...none,
      applyReported: answer.differing.length === 0 ? answer.state : null,
    };
  // Only a definite absence of a payout with no reference opens the other two. A conflict stays
  // with a person: money may have left.
  if (
    answer.state !== 'absent' ||
    issue.kind === 'payout_conflict' ||
    payout.status !== 'REQUESTED' ||
    payout.providerReference !== null ||
    kase.parkedEvent ||
    kase.openConflict
  )
    return none;
  const waitingSince = (payout.startUncertainAt ?? payout.createdAt).getTime();
  return {
    applyReported: null,
    // Never tried at all, so sending it for the first time can't send it twice.
    resume:
      payout.startStep === null &&
      payout.startUncertainAt === null &&
      !kase.holdActive,
    markFailed:
      payout.startStep !== 'payout' &&
      now.getTime() - waitingSince >= PAYOUT_NOT_FOUND_AFTER_MS,
  };
}

function viewOf(kase: Case, answer: Answer, now: Date): OpsPayoutIssueView {
  const known = 'found' in answer ? answer : null;
  return {
    issueId: kase.issue.id,
    issueStatus: kase.issue.status as 'open' | 'resolved',
    payoutStatus: kase.payout.status,
    startStep: kase.payout.startStep as 'fee' | 'payout' | null,
    startAttemptedAt: kase.payout.startUncertainAt?.toISOString() ?? null,
    holdActive: kase.holdActive,
    parkedEvent: kase.parkedEvent,
    openConflict: kase.openConflict,
    destinationReplaced: kase.destinationReplaced,
    read: {
      state: answer.state,
      referenceTail: tail(known?.found.providerReference),
      differing: known?.differing ?? [],
      failureReason: known?.found.failureReason ?? null,
    },
    offers: offersFor(kase, answer, now),
  };
}

async function prepare(db: Database, input: StaffInput) {
  const now = input.now ?? new Date();
  const kase = await guarded(() => loadCase(db, input.issueId));
  if (!kase) throw new OperationError('ISSUE_NOT_FOUND');
  // Outside any transaction: this is network IO.
  const answer = await askProvider(db, kase.payout, input);
  return { kase, answer, now, view: viewOf(kase, answer, now) };
}

const staffAudit = (
  tx: Database | Tx,
  input: StaffInput & { reason?: string },
  kase: Case,
  action: string,
  now: Date,
  note?: string,
) =>
  recordAudit(tx, {
    staffUserId: input.staffUserId,
    action,
    permission: 'payouts.resolve',
    subjectType: 'payout',
    subjectId: kase.payout.id,
    ...(input.reason
      ? { reason: note ? `${input.reason} [${note}]` : input.reason }
      : note
        ? { reason: note }
        : {}),
    now,
  });

/** Refused: said in the audit log too, with what the provider said at that moment. */
async function refused(
  db: Database,
  input: StaffInput & { reason: string },
  prepared: Awaited<ReturnType<typeof prepare>>,
  action: string,
  outcome: 'mismatch' | 'not_offered' | 'not_open',
): Promise<OpsPayoutActionResult> {
  await guarded(() =>
    staffAudit(
      db,
      input,
      prepared.kase,
      'payout.staff_action_refused',
      prepared.now,
      `${action}: ${outcome}, provider said ${prepared.answer.state}`,
    ),
  );
  return { outcome, view: prepared.view };
}

/** What the provider says right now, and what that allows. Changes nothing but the audit log. */
export async function readPayoutIssue(
  db: Database,
  input: StaffInput,
): Promise<OpsPayoutIssueView> {
  const { kase, answer, now, view } = await prepare(db, input);
  await guarded(() =>
    staffAudit(
      db,
      input,
      kase,
      'payout.staff_read',
      now,
      `provider said ${answer.state}`,
    ),
  );
  return view;
}

/** Records what the provider reports, through the same steps a webhook or reconciliation uses. */
export async function applyReportedPayout(
  db: Database,
  input: StaffInput & { reported: 'paid' | 'failed'; reason: string },
): Promise<OpsPayoutActionResult> {
  const prepared = await prepare(db, input);
  const { kase, answer, now, view } = prepared;
  const action = 'apply';
  if (kase.issue.status !== 'open')
    return refused(db, input, prepared, action, 'not_open');
  const unfinished =
    kase.payout.status === 'REQUESTED' || kase.payout.status === 'PROCESSING';
  if (
    unfinished &&
    answer.state === input.reported &&
    'found' in answer &&
    answer.differing.length > 0
  ) {
    await openPayoutConflict(db, {
      payoutId: kase.payout.id,
      why: 'mismatch',
      fields: answer.differing,
      now,
    });
    return refused(db, input, prepared, action, 'mismatch');
  }
  if (view.offers.applyReported !== input.reported || !('found' in answer))
    return refused(db, input, prepared, action, 'not_offered');

  const result = await applyFoundPayout(db, kase.payout, answer.found, now);
  if (result.outcome === 'uncertain')
    return refused(db, input, prepared, action, 'mismatch');
  if (!result.applied)
    return refused(db, input, prepared, action, 'not_offered');
  await guarded(() =>
    db.transaction(async (tx) => {
      await staffAudit(
        tx,
        input,
        kase,
        'payout.staff_applied',
        now,
        input.reported,
      );
      // Told what happened, so unresolved and held are settled. A conflict says money may have gone
      // wrong in a way the payout's state doesn't answer: a person still closes it, with an outcome.
      if (kase.issue.kind !== 'payout_conflict')
        await markResolved(tx, {
          issueId: kase.issue.id,
          resolvedBy: input.staffUserId,
          staffUserId: input.staffUserId,
          reason: input.reason,
          outcome: 'resolved_by_provider',
          now,
        });
    }),
  );
  const after = await guarded(() => loadCase(db, input.issueId));
  return { outcome: 'applied', view: viewOf(after ?? kase, answer, now) };
}

/**
 * Queues the start of a payout that was never tried, once no hold stands in its way. It only queues
 * the job, whose own checks still apply (a new hold stops it; a start already made is only read).
 * The issue stays open until the payout has a reference, so a start that doesn't happen stays seen.
 */
export async function resumeHeldPayout(
  db: Database,
  input: StaffInput & { reason: string },
): Promise<OpsPayoutActionResult> {
  const prepared = await prepare(db, input);
  const { kase, answer, now } = prepared;
  if (kase.issue.status !== 'open')
    return refused(db, input, prepared, 'resume', 'not_open');
  const resumed = await guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(eq(payouts.id, kase.payout.id))
        .for('update');
      const current = await loadCase(tx, input.issueId);
      if (!current || !offersFor(current, answer, now).resume) return false;
      await enqueueOutbox(tx, {
        eventType: PAYOUT_START_EVENT,
        aggregateId: kase.payout.id,
        // The first job took the plain key. A lost one may need asking for twice.
        dedupeSuffix: `resume.${newId()}`,
        payload: {
          payoutId: kase.payout.id,
          profileId: kase.payout.profileId,
        },
      });
      await staffAudit(tx, input, kase, 'payout.staff_resumed', now);
      return true;
    }),
  );
  if (!resumed) return refused(db, input, prepared, 'resume', 'not_offered');
  return { outcome: 'resumed', view: prepared.view };
}

/**
 * Releases the reservation of a payout the provider definitely doesn't have, past the wait, with no
 * payout call ever noted. Staff also say they checked the provider's dashboard. The checks are made
 * again under the row lock, so a start that began meanwhile stops this, and its fresh mark fails
 * the wait. The ledger is untouched: a reservation is only money not yet posted. A top-up that went
 * through stays in the recipient's account at the provider.
 */
export async function markPayoutFailedAbsent(
  db: Database,
  input: StaffInput & { reason: string; dashboardVerified: true },
): Promise<OpsPayoutActionResult> {
  if (input.dashboardVerified !== true)
    throw new OperationError('INVALID_INPUT');
  const prepared = await prepare(db, input);
  const { kase, answer, now } = prepared;
  if (kase.issue.status !== 'open')
    return refused(db, input, prepared, 'mark_failed', 'not_open');
  const done = await guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(eq(payouts.id, kase.payout.id))
        .for('update');
      const current = await loadCase(tx, input.issueId);
      if (!current || !offersFor(current, answer, now).markFailed) return false;
      await recordPayoutOutcomeIn(tx, {
        payoutId: kase.payout.id,
        provider: kase.payout.provider ?? 'unknown',
        providerEventId: `staff-absent.${kase.payout.id}`,
        providerReference: null,
        outcome: 'failed',
        failureReason: 'other',
        // Not the provider's word but its silence, and a person's: audited below.
        signatureVerified: true,
        payload: { source: 'staff', issueId: kase.issue.id },
        now,
      });
      await tx
        .update(payouts)
        .set({ startUncertainAt: null })
        .where(eq(payouts.id, kase.payout.id));
      await staffAudit(
        tx,
        input,
        kase,
        'payout.staff_marked_failed',
        now,
        `start step ${kase.payout.startStep ?? 'none'}; dashboard checked`,
      );
      await markResolved(tx, {
        issueId: kase.issue.id,
        resolvedBy: input.staffUserId,
        staffUserId: input.staffUserId,
        reason: input.reason,
        outcome: 'resolved_by_provider',
        now,
      });
      return true;
    }),
  );
  if (!done) return refused(db, input, prepared, 'mark_failed', 'not_offered');
  const after = await guarded(() => loadCase(db, input.issueId));
  return {
    outcome: 'marked_failed',
    view: viewOf(after ?? kase, answer, now),
  };
}
