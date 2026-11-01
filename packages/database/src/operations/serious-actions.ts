import {
  OPS_CATALOGUE,
  SERIOUS_ACTION_PERMISSIONS,
  type OpsApproval,
  type OpsApprovalStatus,
  type OpsPermission,
  type SeriousAction,
} from '@tipme/contracts';
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, staffTotp, users } from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail, normaliseStaffEmail } from './email-address.js';
import {
  guarded,
  OperationError,
  PersistenceError,
  sqlStateOf,
} from './errors.js';
import { newId } from './ids.js';
import { assertFreshCode } from './ops-sessions.js';
import { enqueueOutbox } from './outbox.js';
import {
  canonicalId,
  checkedReason,
  checkStaffCode,
  lockStaffAdmin,
  readStaffAccess,
  staffAbleToEnterCode,
  withAuditChange,
} from './staff.js';

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_TIMEOUT = '10s';
const LIST_LIMIT = 100;
const SWEEP_BATCH = 100;
// Names that say a value is a credential. Requests sit in the clear for approvers and the log.
const SECRET_KEY = /(code|token|secret)$/i;

export interface SeriousActionContext {
  /** Who asked: their reason is the reason. */
  actorId: string;
  reason: string;
  now: Date;
  /** The second person, or null when it ran alone. */
  approverId: string | null;
}

/**
 * A catalogue action: how to check it, how to say exactly what changes, and how to run it.
 *
 * The payload is stored unsealed and shown to nobody but through `describe`, so it must hold ids and
 * plain values only: a key ending in code, token or secret is refused, and a payload is plain JSON
 * on both paths. If a value's name merely looks like that (`currencyCode`), rename it.
 */
export interface SeriousActionDefinition<Payload> {
  name: string;
  /** Must be sensitive in the catalogue: what the route's fresh code and the second person guard. */
  permission: string;
  /** Throws an OperationError if the facts don't allow it. */
  validate(tx: Tx, payload: Payload): Promise<void>;
  /** Shown to the approver and kept in the log, so server-chosen words, no private details. */
  describe(tx: Tx, payload: Payload): Promise<string>;
  /**
   * Runs holding the global staff-admin lock, under a 10-second statement timeout. So: database
   * work only, and NO PROVIDER CALLS. Queue anything external through the outbox. The result is
   * handed back for the route's normal response. After approval, an OperationError undoes what it
   * wrote and closes the request as stale, so throw one when the facts turn out not to allow it.
   */
  run(tx: Tx, payload: Payload, ctx: SeriousActionContext): Promise<unknown>;
}

export type SeriousActionOutcome =
  | { state: 'ran'; aloneReason: 'no_second_person'; result: unknown }
  | { state: 'pending'; requestId: string };

const registry = new Map<string, SeriousActionDefinition<unknown>>();

export function registerSeriousAction<Payload>(
  action: SeriousActionDefinition<Payload>,
): void {
  if (registry.has(action.name))
    throw new Error(`${action.name} is already registered`);
  const entry = OPS_CATALOGUE[action.permission as OpsPermission];
  if (!entry) throw new Error(`${action.name} names an unknown permission`);
  if (!entry.sensitive)
    throw new Error(`${action.name}: ${action.permission} is not sensitive`);
  const named = SERIOUS_ACTION_PERMISSIONS[action.name as SeriousAction];
  if (named && named !== action.permission)
    throw new Error(`${action.name} must use ${named}`);
  // Each action defines its own payload; what comes back to it is what it was given.
  registry.set(action.name, action as SeriousActionDefinition<unknown>);
}

function holdsNoSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(holdsNoSecret);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, inner]) => !SECRET_KEY.test(key) && holdsNoSecret(inner),
  );
}

/** One form for both paths: running now and running after approval see exactly the same payload. */
function plainPayload(payload: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    // A bigint, or a cycle.
    throw new OperationError('INVALID_INPUT');
  }
  if (text === undefined) throw new OperationError('INVALID_INPUT');
  const plain: unknown = JSON.parse(text);
  if (!holdsNoSecret(plain)) throw new OperationError('INVALID_INPUT');
  return plain;
}

async function runWithinTime(
  tx: Tx,
  run: () => Promise<unknown>,
): Promise<unknown> {
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${RUN_TIMEOUT}'`));
  try {
    const result = await run();
    await tx.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
    return result;
  } catch (error) {
    // A guarded operation inside `run` has already reduced the driver's error to its SQLSTATE.
    const state =
      error instanceof PersistenceError ? error.sqlState : sqlStateOf(error);
    if (state === '57014') throw new OperationError('STAFF_ADMIN_BUSY');
    throw error;
  }
}

/** Live account with a confirmed authenticator: without one, nobody can enter a code. */
async function canEnterCode(tx: Database | Tx, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: staffTotp.userId })
    .from(staffTotp)
    .innerJoin(users, eq(users.id, staffTotp.userId))
    .where(
      and(
        eq(staffTotp.userId, id),
        isNotNull(staffTotp.confirmedAt),
        isNull(users.deletedAt),
      ),
    );
  return Boolean(row);
}

/**
 * Who could be the second person: active staff with a confirmed authenticator on a live account,
 * holding this permission, and not the requester by id or by mailbox. Someone mid-reset can't enter
 * a code, so they don't count, even though they have enrolled before.
 */
export function qualifiedApprovers(
  db: Database | Tx,
  input: { permission: string; requesterId: string },
): Promise<string[]> {
  return guarded(async () => {
    const requesterId = canonicalId(input.requesterId);
    if (!requesterId) throw new OperationError('INVALID_INPUT');
    const [requester] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, requesterId));
    // Phone-based staff have no email: no address is never a match.
    const mailbox = requester?.email
      ? normaliseStaffEmail(requester.email)
      : null;
    const candidates = await staffAbleToEnterCode(db);
    const qualified: string[] = [];
    for (const person of candidates) {
      if (person.userId === requesterId) continue;
      if (
        mailbox &&
        person.email &&
        normaliseStaffEmail(person.email) === mailbox
      )
        continue;
      const access = await readStaffAccess(db, person.userId);
      if (access?.permissions.has(input.permission))
        qualified.push(person.userId);
    }
    return qualified;
  });
}

/**
 * Asks for a serious action. With another qualified person it waits for them; with nobody else, it
 * runs now and says so plainly in the log and an alert (spec 6.5), and approval switches on by
 * itself once someone qualifies.
 *
 * Who qualifies is decided under the staff-admin lock, so a staff change in flight is seen rather
 * than missed. That lock comes first, as in every staff-admin path. The fresh code is checked after
 * it, whatever the route did, so no caller escapes it and time spent queueing counts. A confirmation
 * committing just then (checkStaffCode doesn't take this lock) can be missed: the action then runs
 * alone with its alert, which fails towards visible. The same person asking for the same thing again
 * gets the request already waiting; if nobody qualifies any more they must cancel it first (6.9), so
 * it can't also be approved later by someone new.
 */
export function requestSeriousAction(
  db: Database,
  input: {
    name: string;
    payload: unknown;
    actorId: string;
    /** The ops_sessions row behind this request: `OpsContext.grantId`. */
    grantId: string;
    reason: string;
    now?: Date;
  },
): Promise<SeriousActionOutcome> {
  return guarded(async () => {
    const action = registry.get(input.name);
    if (!action) throw new OperationError('INVALID_INPUT');
    const reason = checkedReason(input.reason);
    const payload = plainPayload(input.payload);
    return db.transaction(async (tx): Promise<SeriousActionOutcome> => {
      await lockStaffAdmin(tx);
      const now = input.now ?? new Date();
      const actorId = canonicalId(input.actorId);
      const access = actorId ? await readStaffAccess(tx, actorId) : null;
      if (
        !actorId ||
        !access?.permissions.has(action.permission) ||
        !(await canEnterCode(tx, actorId))
      )
        throw new OperationError('PERMISSION_NOT_HELD');
      await assertFreshCode(tx, {
        grantId: input.grantId,
        userId: actorId,
        now,
      });

      await action.validate(tx, payload);
      const summary = await action.describe(tx, payload);
      const approvers = await qualifiedApprovers(tx, {
        permission: action.permission,
        requesterId: actorId,
      });
      const [waiting] = await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.status, 'pending'),
            eq(approvalRequests.action, action.name),
            eq(approvalRequests.requestedBy, actorId),
            gt(approvalRequests.expiresAt, now),
            sql`${approvalRequests.payload} = ${JSON.stringify(payload)}::jsonb`,
          ),
        );
      if (waiting && approvers.length === 0)
        throw new OperationError('APPROVAL_ALREADY_PENDING');
      if (waiting) return { state: 'pending', requestId: waiting.id };

      if (approvers.length > 0) {
        const requestId = newId();
        await tx.insert(approvalRequests).values({
          id: requestId,
          action: action.name,
          payload,
          summary,
          permission: action.permission,
          requestedBy: actorId,
          reason,
          createdAt: now,
          expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
        });
        await recordAudit(tx, {
          staffUserId: actorId,
          action: 'serious_action.requested',
          permission: action.permission,
          subjectType: 'approval_request',
          subjectId: requestId,
          reason: withAuditChange(reason, {
            action: action.name,
            summary,
            requestedBy: actorId,
            approvedBy: null,
          }),
          now,
        });
        await enqueueOutbox(tx, {
          eventType: 'ops.approval_pending',
          aggregateId: requestId,
          payload: {
            action: action.name,
            requestedBy: actorId,
            requestId,
            permission: action.permission,
          },
        });
        return { state: 'pending', requestId };
      }

      const result = await runWithinTime(tx, () =>
        action.run(tx, payload, { actorId, reason, now, approverId: null }),
      );
      await recordAudit(tx, {
        staffUserId: actorId,
        action: 'serious_action.ran_alone',
        permission: action.permission,
        subjectType: 'serious_action',
        subjectId: action.name,
        reason: withAuditChange(reason, {
          action: action.name,
          summary,
          requestedBy: actorId,
          approvedBy: null,
          aloneReason: 'no_second_person',
          note: 'Ran without a second person because none was available',
        }),
        now,
      });
      await enqueueOutbox(tx, {
        eventType: 'ops.acted_alone',
        // Each occurrence is its own alert.
        aggregateId: newId(),
        payload: { action: action.name, requestedBy: actorId },
      });
      return { state: 'ran', aloneReason: 'no_second_person', result };
    });
  });
}

type ApprovalRow = typeof approvalRequests.$inferSelect;

async function lockRequest(tx: Tx, id: string): Promise<ApprovalRow> {
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .for('update');
  if (!row) throw new OperationError('APPROVAL_NOT_FOUND');
  return row;
}

const requestIdOrThrow = (id: string): string => {
  const requestId = canonicalId(id);
  if (!requestId) throw new OperationError('APPROVAL_NOT_FOUND');
  return requestId;
};

/** Ends a pending request and logs it. `change` adds who did what to the server's record. */
async function closeRequest(
  tx: Tx,
  request: ApprovalRow,
  close: {
    status: Exclude<OpsApprovalStatus, 'pending'>;
    event: string;
    staffUserId: string | null;
    decidedBy?: string;
    decidedReason?: string;
    reason: string;
    change: object;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(approvalRequests)
    .set({
      status: close.status,
      decidedBy: close.decidedBy ?? null,
      decidedReason: close.decidedReason ?? null,
      decidedAt: close.now,
    })
    .where(eq(approvalRequests.id, request.id));
  await recordAudit(tx, {
    staffUserId: close.staffUserId,
    action: close.event,
    permission: request.permission,
    subjectType: 'approval_request',
    subjectId: request.id,
    reason: withAuditChange(close.reason, stepRecord(request, close.change)),
    now: close.now,
  });
}

const stepRecord = (request: ApprovalRow, change: object) => ({
  action: request.action,
  summary: request.summary,
  requestedBy: request.requestedBy,
  ...change,
});

const expire = (tx: Tx, request: ApprovalRow, now: Date) =>
  closeRequest(tx, request, {
    status: 'expired',
    event: 'serious_action.expired',
    staffUserId: null,
    reason: 'Nobody decided it within 24 hours',
    change: {},
    now,
  });

async function isSameMailbox(
  tx: Database | Tx,
  firstId: string,
  secondId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(inArray(users.id, [firstId, secondId]));
  const [first, second] = rows.map((row) =>
    row.email ? normaliseStaffEmail(row.email) : null,
  );
  return rows.length === 2 && first !== null && first === second;
}

/** May this person decide this request at all? Asked before any code is looked at or used. */
async function deciderOrThrow(
  tx: Tx,
  request: ApprovalRow,
  rawActorId: string,
): Promise<string> {
  const actorId = canonicalId(rawActorId);
  if (actorId === request.requestedBy)
    throw new OperationError('APPROVAL_OWN_REQUEST');
  const access = actorId ? await readStaffAccess(tx, actorId) : null;
  if (
    !actorId ||
    !access?.permissions.has(request.permission) ||
    !(await canEnterCode(tx, actorId))
  )
    throw new OperationError('PERMISSION_NOT_HELD');
  if (await isSameMailbox(tx, actorId, request.requestedBy))
    throw new OperationError('APPROVAL_OWN_REQUEST');
  return actorId;
}

async function requesterStillHolds(
  tx: Tx,
  request: ApprovalRow,
): Promise<boolean> {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, request.requestedBy), isNull(users.deletedAt)));
  if (!account) return false;
  const access = await readStaffAccess(tx, request.requestedBy);
  return Boolean(access?.permissions.has(request.permission));
}

const DESCRIPTION_CHANGED = Symbol('description changed');

/**
 * Re-checks the facts and runs, in a savepoint. A refusal, from validate or from run, undoes the
 * action's writes and comes back as the reason; the caller still commits the closed request. Busy
 * and unexpected errors go on up, undoing everything, so the request and the code survive to retry.
 */
async function checkAndRun(
  tx: Tx,
  request: ApprovalRow,
  context: SeriousActionContext,
): Promise<{ ran: true; result: unknown } | { ran: false; why: string }> {
  const action = registry.get(request.action);
  if (!action) return { ran: false, why: 'action_unknown' };
  try {
    const result = await runWithinTime(tx, () =>
      tx.transaction(async (savepoint) => {
        await action.validate(savepoint, request.payload);
        const summary = await action.describe(savepoint, request.payload);
        // The approver agreed to the words they read; if those no longer hold, nor does the approval.
        if (summary !== request.summary) return DESCRIPTION_CHANGED;
        return action.run(savepoint, request.payload, context);
      }),
    );
    if (result === DESCRIPTION_CHANGED)
      return { ran: false, why: 'description_changed' };
    return { ran: true, result };
  } catch (error) {
    if (!(error instanceof OperationError) || error.code === 'STAFF_ADMIN_BUSY')
      throw error;
    await tx.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
    return { ran: false, why: error.code };
  }
}

export type ApprovalOutcome =
  | { status: 'approved'; result: unknown }
  /** Closed without running: the facts, or the people, changed. */
  | { status: 'stale'; why: string }
  | { status: 'expired' }
  /** The code didn't pass, and nothing else happened. */
  | { status: 'invalid' | 'locked' | 'reused' };

/**
 * A second person approves, with a code entered for this approval: the 5-minute window doesn't count
 * (spec 6.9). That code is theirs, checked and consumed like any other, so it can't also open a grant,
 * and a code just used for that gets `reused`: they wait for the next one. Being refused the right to
 * decide, or finding it closed or expired, uses no code; a stale outcome does, as the decision was made.
 *
 * Everything commits or nothing does. So a wrong code still counts (the outcome comes back rather than
 * throwing), while STAFF_ADMIN_BUSY, from the lock or an overrunning run, leaves the request pending
 * and the code unused. Runs under the staff-admin lock, then the request's row, then the person's
 * rows as checkStaffCode takes them, with no provider call: an action's `run` must make none.
 */
export function approveRequest(
  db: Database,
  input: {
    requestId: string;
    actorId: string;
    code: string;
    key: Buffer;
    reason?: string;
    now?: Date;
  },
): Promise<ApprovalOutcome> {
  return guarded(async () => {
    const requestId = requestIdOrThrow(input.requestId);
    const reason =
      input.reason === undefined ? null : checkedReason(input.reason);
    return db.transaction(async (tx): Promise<ApprovalOutcome> => {
      await lockStaffAdmin(tx);
      const now = input.now ?? new Date();
      const request = await lockRequest(tx, requestId);
      const actorId = await deciderOrThrow(tx, request, input.actorId);
      if (request.status !== 'pending')
        throw new OperationError('APPROVAL_CLOSED');
      if (now >= request.expiresAt) {
        await expire(tx, request, now);
        return { status: 'expired' };
      }
      const check = await checkStaffCode(tx, {
        userId: actorId,
        code: input.code,
        key: input.key,
        now,
        confirmed: true,
      });
      if (check === 'not_enrolled')
        throw new OperationError('PERMISSION_NOT_HELD');
      if (check !== 'ok') return { status: check };

      const both = { approvedBy: actorId };
      const stop = async (why: string): Promise<ApprovalOutcome> => {
        await closeRequest(tx, request, {
          status: 'stale',
          event: 'serious_action.stale',
          staffUserId: actorId,
          decidedBy: actorId,
          decidedReason: why,
          reason: 'Stopped at approval, and nothing ran',
          change: { ...both, why },
          now,
        });
        return { status: 'stale', why };
      };
      if (!(await requesterStillHolds(tx, request)))
        return stop('requester_lost_access');
      const outcome = await checkAndRun(tx, request, {
        actorId: request.requestedBy,
        reason: request.reason,
        now,
        approverId: actorId,
      });
      if (!outcome.ran) return stop(outcome.why);

      await closeRequest(tx, request, {
        status: 'approved',
        event: 'serious_action.approved',
        staffUserId: actorId,
        decidedBy: actorId,
        ...(reason ? { decidedReason: reason } : {}),
        reason: reason ?? 'Approved',
        change: both,
        now,
      });
      await recordAudit(tx, {
        staffUserId: actorId,
        action: 'serious_action.ran',
        permission: request.permission,
        subjectType: 'approval_request',
        subjectId: request.id,
        reason: withAuditChange(request.reason, stepRecord(request, both)),
        now,
      });
      return { status: 'approved', result: outcome.result };
    });
  });
}

/** A second person says no. Takes the usual fresh code (spec 6.5 step 3), and always a reason. */
export function rejectRequest(
  db: Database,
  input: {
    requestId: string;
    actorId: string;
    grantId: string;
    reason: string;
    now?: Date;
  },
): Promise<void> {
  return guarded(async () => {
    const requestId = requestIdOrThrow(input.requestId);
    const reason = checkedReason(input.reason);
    const expired = await db.transaction(async (tx) => {
      await lockStaffAdmin(tx);
      const now = input.now ?? new Date();
      const request = await lockRequest(tx, requestId);
      const actorId = await deciderOrThrow(tx, request, input.actorId);
      if (request.status !== 'pending')
        throw new OperationError('APPROVAL_CLOSED');
      await assertFreshCode(tx, {
        grantId: input.grantId,
        userId: actorId,
        now,
      });
      if (now >= request.expiresAt) {
        await expire(tx, request, now);
        return true;
      }
      await closeRequest(tx, request, {
        status: 'rejected',
        event: 'serious_action.rejected',
        staffUserId: actorId,
        decidedBy: actorId,
        decidedReason: reason,
        reason,
        change: { rejectedBy: actorId },
        now,
      });
      return false;
    });
    // After the commit, so the expiry stays recorded.
    if (expired) throw new OperationError('APPROVAL_EXPIRED');
  });
}

/**
 * The requester takes it back. It only stops something, so it asks for no code, and still works if
 * they've since lost the permission. With nobody left to decide, this is how they get to act alone.
 */
export function cancelRequest(
  db: Database,
  input: { requestId: string; actorId: string; now?: Date },
): Promise<void> {
  return guarded(async () => {
    const requestId = requestIdOrThrow(input.requestId);
    const expired = await db.transaction(async (tx) => {
      await lockStaffAdmin(tx);
      const now = input.now ?? new Date();
      const request = await lockRequest(tx, requestId);
      const actorId = canonicalId(input.actorId);
      if (actorId !== request.requestedBy)
        throw new OperationError('APPROVAL_NOT_YOURS');
      if (!(await readStaffAccess(tx, actorId)))
        throw new OperationError('APPROVAL_NOT_YOURS');
      if (request.status !== 'pending')
        throw new OperationError('APPROVAL_CLOSED');
      if (now >= request.expiresAt) {
        await expire(tx, request, now);
        return true;
      }
      await closeRequest(tx, request, {
        status: 'cancelled',
        event: 'serious_action.cancelled',
        staffUserId: actorId,
        decidedBy: actorId,
        reason: 'Cancelled by the person who asked',
        change: {},
        now,
      });
      return false;
    });
    if (expired) throw new OperationError('APPROVAL_EXPIRED');
  });
}

/**
 * The sweep. Doesn't take the staff-admin lock, as it changes nobody's access, and skips a row someone
 * is deciding right now: that decision sees the time itself. A decision arriving behind this waits on
 * the row and then finds it closed. Either way, one outcome.
 */
export function expireRequests(
  db: Database,
  input: { now: Date },
): Promise<{ expired: number }> {
  return guarded(async () => {
    let expired = 0;
    for (;;) {
      const batch = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.status, 'pending'),
              lte(approvalRequests.expiresAt, input.now),
            ),
          )
          .limit(SWEEP_BATCH)
          .for('update', { skipLocked: true });
        for (const request of rows) await expire(tx, request, input.now);
        return rows.length;
      });
      expired += batch;
      if (batch < SWEEP_BATCH) return { expired };
    }
  });
}

/**
 * What this person may see: requests under permissions they hold, and their own. Newest first, and
 * never the payload. One lapsed but not yet swept reads as expired.
 */
export function listApprovals(
  db: Database,
  input: { actorId: string; status?: OpsApprovalStatus; now?: Date },
): Promise<OpsApproval[]> {
  return guarded(async () => {
    const actorId = canonicalId(input.actorId);
    const access = actorId ? await readStaffAccess(db, actorId) : null;
    if (!actorId || !access) return [];
    const now = input.now ?? new Date();
    const held = [...access.permissions];
    const seen = or(
      eq(approvalRequests.requestedBy, actorId),
      held.length > 0 ? inArray(approvalRequests.permission, held) : undefined,
    );
    const lapsed = and(
      eq(approvalRequests.status, 'pending'),
      lte(approvalRequests.expiresAt, now),
    );
    const wanted =
      input.status === 'pending'
        ? and(
            eq(approvalRequests.status, 'pending'),
            gt(approvalRequests.expiresAt, now),
          )
        : input.status === 'expired'
          ? or(eq(approvalRequests.status, 'expired'), lapsed)
          : input.status
            ? eq(approvalRequests.status, input.status)
            : undefined;
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(and(seen, wanted))
      .orderBy(desc(approvalRequests.createdAt))
      .limit(LIST_LIMIT);
    if (rows.length === 0) return [];

    const ids = new Set<string>([actorId]);
    for (const row of rows) {
      ids.add(row.requestedBy);
      if (row.decidedBy) ids.add(row.decidedBy);
    }
    const accounts = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, [...ids]));
    const emails = new Map(accounts.map((row) => [row.id, row.email]));
    const hint = (id: string | null) => {
      const email = id ? emails.get(id) : null;
      return email ? maskEmail(email) : null;
    };
    const mailboxOf = (id: string) => {
      const email = emails.get(id);
      return email ? normaliseStaffEmail(email) : null;
    };
    const actorAble = await canEnterCode(db, actorId);
    // Many requests share a requester and permission, and each answer walks all the staff.
    const nobody = new Map<string, Promise<boolean>>();
    const nobodyElse = (row: ApprovalRow) => {
      const key = `${row.requestedBy}.${row.permission}`;
      const known = nobody.get(key);
      if (known) return known;
      const answer = qualifiedApprovers(db, {
        permission: row.permission,
        requesterId: row.requestedBy,
      }).then((people) => people.length === 0);
      nobody.set(key, answer);
      return answer;
    };

    const views: OpsApproval[] = [];
    for (const row of rows) {
      const open = row.status === 'pending' && now < row.expiresAt;
      const mine = row.requestedBy === actorId;
      const actorMailbox = mailboxOf(actorId);
      views.push({
        id: row.id,
        action: row.action,
        summary: row.summary,
        permission: row.permission,
        requestedBy: row.requestedBy,
        requestedByHint: hint(row.requestedBy),
        reason: row.reason,
        status:
          row.status === 'pending' && !open
            ? 'expired'
            : (row.status as OpsApprovalStatus),
        decidedBy: row.decidedBy,
        decidedByHint: hint(row.decidedBy),
        decidedReason: row.decidedReason,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        mine,
        canDecide:
          open &&
          !mine &&
          actorAble &&
          access.permissions.has(row.permission) &&
          (actorMailbox === null ||
            actorMailbox !== mailboxOf(row.requestedBy)),
        nobodyElseQualified: open && (await nobodyElse(row)),
      });
    }
    return views;
  });
}
