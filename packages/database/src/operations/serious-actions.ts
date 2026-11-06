import {
  OPS_CATALOGUE,
  SERIOUS_ACTION_PERMISSIONS,
  type OpsApproval,
  type OpsApprovalStaleReason,
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
import type { MailProviderName } from '@tipme/mail';
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
import type { MailSealing } from './mail-queue.js';
import type { PayoutStartLog } from './payout-start.js';
import type { StaffPayoutReader } from './payout-staff.js';
import {
  canonicalId,
  checkedReason,
  checkStaffCode,
  lockStaffAdmin,
  readMailboxes,
  readStaffAccess,
  sharesMailbox,
  staffAbleToEnterCode,
  type StaffAccess,
  whileHoldingStaffAdmin,
  withAuditChange,
} from './staff.js';

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_TIMEOUT = '10s';
// The statement timeout can't see many short statements, or a wait outside the database.
const RUN_DEADLINE_MS = 15_000;
const LIST_LIMIT = 100;
const SWEEP_BATCH = 100;
// Names that say a value is a credential. Requests sit in the clear for approvers and the log.
const SECRET_KEY = /(code|token|secret)$/i;

/**
 * What real actions need from the running app. The API supplies it when asking and approving. The
 * worker only reads who may decide, so it never needs it. `sealing` queues mail in the transaction.
 */
export interface SeriousActionServices {
  sealing: MailSealing;
  authCodeSecret: string;
  /** Used only by `prepare`, outside the transaction. */
  payoutReader?: (name: string) => StaffPayoutReader;
  payoutLog?: PayoutStartLog;
  /**
   * Business release 2: whether `BUSINESS_ENABLED` and `BUSINESS_SHARES_ENABLED` are both on.
   * `tip.reverse` runs only then, also when it is approved later.
   */
  businessSharesEnabled?: boolean;
  mail?: {
    production: boolean;
    configured: ReadonlySet<MailProviderName>;
    fallback: MailProviderName;
    /** Used only by `prepare`, outside the transaction. Null when it can't be read. */
    status(name: string): Promise<{ sandbox: boolean | null } | null>;
  };
}

export interface SeriousActionContext {
  /** Who asked: their reason is the reason. */
  actorId: string;
  reason: string;
  now: Date;
  /** The second person, or null when it ran alone. */
  approverId: string | null;
  services?: SeriousActionServices | undefined;
  /** What `prepare` found, before the transaction. Never stored. */
  facts?: unknown;
}

/** What validate may use besides the payload. */
export interface SeriousActionCheck {
  actorId: string;
  reason: string;
  now: Date;
  services?: SeriousActionServices | undefined;
  facts?: unknown;
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
  validate(tx: Tx, payload: Payload, check: SeriousActionCheck): Promise<void>;
  /**
   * Anything that must wait on something other than this database (a provider's answer) goes here.
   * It runs before the transaction, on both paths, each time. What it returns reaches `validate` and
   * `run` as `facts`. If it throws, nothing has happened and a waiting request stays waiting.
   */
  prepare?(
    db: Database,
    payload: Payload,
    input: { actorId: string; services?: SeriousActionServices | undefined },
  ): Promise<unknown>;
  /**
   * Whether this person could take the action directly: the action's own rules beyond holding
   * `permission` (owner only, must hold what is being granted). Someone it refuses can't approve and
   * doesn't count as a second person. Leave out if the permission is enough.
   */
  mayDecide?(
    tx: Database | Tx,
    payload: Payload,
    approver: { userId: string; access: StaffAccess },
  ): Promise<boolean>;
  /** Who this benefits or concerns, by user id. They can't decide it, by id or by mailbox. */
  subjects?(payload: Payload, db: Database | Tx): string[] | Promise<string[]>;
  /**
   * After a refusal has undone the run, so what it records stays: on approval, in the transaction
   * that closes the request; when asking, on its own after the rollback.
   */
  afterRefusal?(
    db: Database,
    payload: Payload,
    refusal: { detail: string | undefined },
    check: SeriousActionCheck,
  ): Promise<void>;
  /** Addresses the change would hand something to: nobody behind one can decide it. */
  mailboxes?(payload: Payload): string[];
  /**
   * The payload to keep once decided, in the transaction that closes it: addresses are only needed
   * to run the action, and the summary already holds them masked.
   */
  afterClose?(payload: Payload): Payload;
  /**
   * What the action applies to, say the role or page. Acting alone closes the requester's other
   * requests with the same target. Leave out and the whole action counts as one target.
   */
  target?(payload: Payload): string;
  /**
   * The current value the change depends on (a fee, a role's updated_at). Stored when asked for and
   * compared at approval, so a request can't overwrite something that has moved since. Plain JSON.
   */
  current?(tx: Tx, payload: Payload): Promise<unknown>;
  /** Shown to the approver and kept in the log, so server-chosen words, no private details. */
  describe(tx: Tx, payload: Payload): Promise<string>;
  /**
   * Runs holding the global staff-admin lock, under a 10-second statement timeout. It may only wait
   * on this transaction: pass `tx` to anything it calls, as another connection would wait on this
   * one. No mail sending, webhook, provider call or storage: those happen after commit, through the
   * outbox or the route (read beforehand in `prepare`). The fence below can't make up for breaking
   * this. The result is handed back for the route's normal response. After approval, an OperationError undoes what it
   * wrote and closes the request as stale, so throw one when the facts turn out not to allow it.
   */
  run(tx: Tx, payload: Payload, ctx: SeriousActionContext): Promise<unknown>;
}

export type SeriousActionOutcome =
  | {
      state: 'ran';
      aloneReason: 'no_second_person';
      result: unknown;
      /** The requester's waiting requests this replaced, now closed. */
      superseded: string[];
    }
  | {
      state: 'pending';
      requestId: string;
      /** The same thing was already waiting: this is that request. Their reason is in the audit log. */
      repeat?: true;
    };

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

/** The same transaction, until the gate shuts: after that, using it is refused rather than run. */
function fenced(tx: Tx, gate: { shut: boolean }): Tx {
  return new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (gate.shut) throw new OperationError('STAFF_ADMIN_BUSY');
        if (property === 'transaction') {
          const [work, ...rest] = args as [
            (inner: Tx) => unknown,
            ...unknown[],
          ];
          return (value as (...all: unknown[]) => unknown).call(
            target,
            (inner: Tx) => work(fenced(inner, gate)),
            ...rest,
          );
        }
        return (value as (...all: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Runs an action's work holding the global lock, within a per-statement and an overall limit. Past
 * either, STAFF_ADMIN_BUSY: the caller's transaction undoes everything. JavaScript can't be stopped,
 * so a fresh call after the deadline finds its transaction fenced off. That is all the fence does: a
 * statement built before the deadline and awaited after it, or a savepoint released late, reaches a
 * client that is back in the pool and may be someone else's. So a run must wait only on the database
 * (ruling N1), where the connection's own queue keeps those statements in order. Call this inside the
 * savepoint or transaction to undo.
 */
async function runWithinTime(
  tx: Tx,
  work: (fencedTx: Tx) => Promise<unknown>,
): Promise<unknown> {
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${RUN_TIMEOUT}'`));
  const gate = { shut: false };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      gate.shut = true;
      reject(new OperationError('STAFF_ADMIN_BUSY'));
    }, RUN_DEADLINE_MS);
  });
  try {
    const result = await whileHoldingStaffAdmin(() =>
      Promise.race([work(fenced(tx, gate)), deadline]),
    );
    await tx.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
    return result;
  } catch (error) {
    // A guarded operation inside `run` has already reduced the driver's error to its SQLSTATE.
    const state =
      error instanceof PersistenceError ? error.sqlState : sqlStateOf(error);
    if (state === '57014') throw new OperationError('STAFF_ADMIN_BUSY');
    throw error;
  } finally {
    gate.shut = true;
    clearTimeout(timer);
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
 * Why this person, already known to hold the permission and able to enter a code, can't decide this
 * action, or null. Same answer for approving, qualifying and the list.
 */
async function refusalToDecide(
  db: Database | Tx,
  input: {
    action: string | undefined;
    payload: unknown;
    requesterId: string;
    decider: { userId: string; access: StaffAccess };
  },
): Promise<
  'APPROVAL_OWN_REQUEST' | 'APPROVAL_SUBJECT' | 'PERMISSION_NOT_HELD' | null
> {
  const { userId } = input.decider;
  if (userId === input.requesterId) return 'APPROVAL_OWN_REQUEST';
  const theirs = await readMailboxes(db, userId);
  if (sharesMailbox(theirs, await readMailboxes(db, input.requesterId)))
    return 'APPROVAL_OWN_REQUEST';
  const action = input.action ? registry.get(input.action) : undefined;
  if (action?.mayDecide) {
    if (!(await action.mayDecide(db, input.payload, input.decider)))
      return 'PERMISSION_NOT_HELD';
  }
  for (const address of action?.mailboxes?.(input.payload) ?? [])
    if (theirs.has(normaliseStaffEmail(address))) return 'APPROVAL_SUBJECT';
  for (const subject of (await action?.subjects?.(input.payload, db)) ?? []) {
    const subjectId = canonicalId(subject);
    if (subjectId === userId) return 'APPROVAL_SUBJECT';
    if (subjectId && sharesMailbox(theirs, await readMailboxes(db, subjectId)))
      return 'APPROVAL_SUBJECT';
  }
  return null;
}

/**
 * Who could be the second person: active staff with a confirmed authenticator on a live account,
 * holding this permission, and not the requester by id or by mailbox. Someone mid-reset can't enter
 * a code, so they don't count, even though they have enrolled before. Given the action and payload,
 * the action's own rules apply too: anyone it refuses is no second person.
 */
export function qualifiedApprovers(
  db: Database | Tx,
  input: {
    permission: string;
    requesterId: string;
    action?: string;
    payload?: unknown;
  },
): Promise<string[]> {
  return guarded(async () => {
    const requesterId = canonicalId(input.requesterId);
    if (!requesterId) throw new OperationError('INVALID_INPUT');
    const qualified: string[] = [];
    for (const person of await staffAbleToEnterCode(db)) {
      const access = await readStaffAccess(db, person.userId);
      if (!access?.permissions.has(input.permission)) continue;
      const refusal = await refusalToDecide(db, {
        action: input.action,
        payload: input.payload,
        requesterId,
        decider: { userId: person.userId, access },
      });
      if (!refusal) qualified.push(person.userId);
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
 * alone with its alert, which fails towards visible. Anyone asking for what is already waiting gets
 * that request, marked as a repeat, so two people can't each approve the other's copy. If nobody
 * qualifies any more, the requester must cancel an identical one first (6.9). Acting alone closes
 * their other requests for the same target, so an older one can't overwrite it later.
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
    services?: SeriousActionServices;
  },
): Promise<SeriousActionOutcome> {
  return guarded(async () => {
    const action = registry.get(input.name);
    if (!action) throw new OperationError('INVALID_INPUT');
    const reason = checkedReason(input.reason);
    const payload = plainPayload(input.payload);
    const facts = await action.prepare?.(db, payload, {
      actorId: input.actorId,
      services: input.services,
    });
    let attempted: SeriousActionCheck | null = null;
    return db
      .transaction(async (tx): Promise<SeriousActionOutcome> => {
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

        const check = {
          actorId,
          reason,
          now,
          services: input.services,
          facts,
        };
        // The check is a dry run, so a refusal there is as real as one in the run.
        attempted = check;
        await whileHoldingStaffAdmin(() => action.validate(tx, payload, check));
        const summary = await action.describe(tx, payload);
        const pinned = action.current
          ? plainPayload((await action.current(tx, payload)) ?? null)
          : null;
        const approvers = await qualifiedApprovers(tx, {
          permission: action.permission,
          requesterId: actorId,
          action: action.name,
          payload,
        });
        const waiting = await tx
          .select({
            id: approvalRequests.id,
            requestedBy: approvalRequests.requestedBy,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.status, 'pending'),
              eq(approvalRequests.action, action.name),
              gt(approvalRequests.expiresAt, now),
              sql`${approvalRequests.payload} = ${JSON.stringify(payload)}::jsonb`,
              sql`${approvalRequests.pinned} IS NOT DISTINCT FROM ${pinned === null ? null : JSON.stringify(pinned)}::jsonb`,
            ),
          );
        if (
          approvers.length === 0 &&
          waiting.some((row) => row.requestedBy === actorId)
        )
          throw new OperationError('APPROVAL_ALREADY_PENDING');
        if (approvers.length > 0 && waiting[0]) {
          // Their reason goes nowhere else, and the owner's ruling is a full log.
          await recordAudit(tx, {
            staffUserId: actorId,
            action: 'serious_action.repeated',
            permission: action.permission,
            subjectType: 'approval_request',
            subjectId: waiting[0].id,
            reason: withAuditChange(reason, {
              action: action.name,
              summary,
              requestedBy: waiting[0].requestedBy,
              alsoAskedBy: actorId,
            }),
            now,
          });
          return { state: 'pending', requestId: waiting[0].id, repeat: true };
        }

        if (approvers.length > 0) {
          const requestId = newId();
          await tx.insert(approvalRequests).values({
            id: requestId,
            action: action.name,
            payload,
            pinned,
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

        const superseded = await closeSuperseded(
          tx,
          action,
          payload,
          actorId,
          now,
        );
        const result = await runWithinTime(tx, (fencedTx) =>
          action.run(fencedTx, payload, {
            actorId,
            reason,
            now,
            approverId: null,
            services: input.services,
            facts,
          }),
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
        return {
          state: 'ran',
          aloneReason: 'no_second_person',
          result,
          superseded,
        };
      })
      .catch(async (error: unknown) => {
        if (
          attempted &&
          action.afterRefusal &&
          error instanceof OperationError &&
          error.code !== 'STAFF_ADMIN_BUSY'
        )
          await action.afterRefusal(
            db,
            payload,
            { detail: error.detail },
            attempted,
          );
        throw error;
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
    /** The requester already knows, because it's their own doing or it's about them. */
    quiet?: boolean;
  },
): Promise<void> {
  await tx
    .update(approvalRequests)
    .set({
      status: close.status,
      decidedBy: close.decidedBy ?? null,
      decidedReason: close.decidedReason ?? null,
      decidedAt: close.now,
      payload:
        registry.get(request.action)?.afterClose?.(request.payload) ??
        request.payload,
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
  // Quiet means no mail to someone who knows: the alert route still hears.
  if (
    close.status === 'rejected' ||
    close.status === 'stale' ||
    close.status === 'expired'
  )
    await enqueueOutbox(tx, {
      eventType: 'ops.approval_closed',
      aggregateId: request.id,
      payload: {
        requestId: request.id,
        action: request.action,
        requestedBy: request.requestedBy,
        outcome: close.status,
        ...(close.quiet ? { quiet: 'yes' } : {}),
      },
    });
}

/** A serious action's stale close that nobody tried to approve. */
const closeStaleQuietly = (
  tx: Tx,
  request: ApprovalRow,
  input: {
    why: OpsApprovalStaleReason;
    actorId: string | null;
    now: Date;
    /** Someone else's request ended by this: they need telling. */
    tellRequester?: boolean;
  },
) =>
  closeRequest(tx, request, {
    status: 'stale',
    event: 'serious_action.stale',
    staffUserId: input.actorId,
    ...(input.actorId ? { decidedBy: input.actorId } : {}),
    decidedReason: input.why,
    reason: 'Closed without running',
    change: { why: input.why },
    now: input.now,
    quiet: !input.tellRequester,
  });

const lockPendingOf = (tx: Tx, userId: string) =>
  tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.requestedBy, userId),
      ),
    )
    .for('update');

/**
 * Removed or reset, a person's waiting requests end with them: bringing them back mustn't revive what
 * may have been asked for from a stolen phone. The caller holds the staff-admin lock.
 */
export async function closePendingRequestsOf(
  tx: Tx,
  input: {
    userId: string;
    why: 'requester_removed' | 'requester_reset';
    actorId: string | null;
    now: Date;
  },
): Promise<void> {
  for (const request of await lockPendingOf(tx, input.userId))
    await closeStaleQuietly(tx, request, input);
}

/**
 * Every waiting request on the target ends once someone acts alone, whoever asked: one left waiting
 * could be approved later and run the same thing twice, or overwrite this (N2). Those from other
 * people are told. The caller holds the staff-admin lock.
 */
async function closeSuperseded(
  tx: Tx,
  action: SeriousActionDefinition<unknown>,
  payload: unknown,
  actorId: string,
  now: Date,
): Promise<string[]> {
  const target = action.target?.(payload);
  const closed: string[] = [];
  const pending = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.action, action.name),
      ),
    )
    .for('update');
  for (const request of pending)
    if (action.target?.(request.payload) === target) {
      await closeStaleQuietly(tx, request, {
        why: 'superseded',
        actorId,
        now,
        tellRequester: request.requestedBy !== actorId,
      });
      closed.push(request.id);
    }
  return closed;
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
  const refusal = await refusalToDecide(tx, {
    action: request.action,
    payload: request.payload,
    requesterId: request.requestedBy,
    decider: { userId: actorId, access },
  });
  if (refusal) throw new OperationError(refusal);
  return actorId;
}

/** Still staff, holding it, and able to enter a code: a phone reported stolen ends what it asked for. */
async function requesterStillHolds(
  tx: Tx,
  request: ApprovalRow,
): Promise<boolean> {
  if (!(await canEnterCode(tx, request.requestedBy))) return false;
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
): Promise<
  | { ran: true; result: unknown }
  | { ran: false; why: OpsApprovalStaleReason; detail?: string }
> {
  const action = registry.get(request.action);
  if (!action) return { ran: false, why: 'action_unknown' };
  // The approver was checked against the stored permission, so it must still be the action's.
  if (action.permission !== request.permission)
    return { ran: false, why: 'permission_changed' };
  try {
    const result = await tx.transaction((savepoint) =>
      runWithinTime(savepoint, async (work) => {
        await action.validate(work, request.payload, context);
        if (action.current) {
          const now = plainPayload(
            (await action.current(work, request.payload)) ?? null,
          );
          const [same] = await work
            .select({
              same: sql<boolean>`${approvalRequests.pinned} IS NOT DISTINCT FROM ${now === null ? null : JSON.stringify(now)}::jsonb`,
            })
            .from(approvalRequests)
            .where(eq(approvalRequests.id, request.id));
          if (!same?.same)
            throw new OperationError('STAFF_CHANGED', 'pinned_value_moved');
        }
        const summary = await action.describe(work, request.payload);
        // The approver agreed to the words they read; if those no longer hold, nor does the approval.
        if (summary !== request.summary) return DESCRIPTION_CHANGED;
        return action.run(work, request.payload, context);
      }),
    );
    if (result === DESCRIPTION_CHANGED)
      return { ran: false, why: 'description_changed' };
    return { ran: true, result };
  } catch (error) {
    if (!(error instanceof OperationError) || error.code === 'STAFF_ADMIN_BUSY')
      throw error;
    // The raw code goes to the log; a screen gets one safe reason.
    return {
      ran: false,
      why: 'facts_changed',
      detail: error.detail ?? error.code,
    };
  }
}

/**
 * The waiting on a provider happens here, before any lock. Only for someone who may decide this, on
 * a request still open: everything is asked again under the lock.
 */
async function factsForApproval(
  db: Database,
  requestId: string,
  input: { actorId: string; services?: SeriousActionServices },
): Promise<unknown> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  const prepare = row && registry.get(row.action);
  if (!row || row.status !== 'pending' || !prepare?.prepare) return undefined;
  await db.transaction((tx) => deciderOrThrow(tx, row, input.actorId));
  return prepare.prepare(db, row.payload, {
    actorId: row.requestedBy,
    services: input.services,
  });
}

export type ApprovalOutcome =
  | { status: 'approved'; result: unknown }
  /** Closed without running: the facts, or the people, changed. */
  | { status: 'stale'; why: OpsApprovalStaleReason }
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
    services?: SeriousActionServices;
  },
): Promise<ApprovalOutcome> {
  return guarded(async () => {
    const requestId = requestIdOrThrow(input.requestId);
    const reason =
      input.reason === undefined ? null : checkedReason(input.reason);
    const facts = await factsForApproval(db, requestId, input);
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
      const stop = async (
        why: OpsApprovalStaleReason,
        detail?: string,
      ): Promise<ApprovalOutcome> => {
        await closeRequest(tx, request, {
          status: 'stale',
          event: 'serious_action.stale',
          staffUserId: actorId,
          decidedBy: actorId,
          decidedReason: why,
          reason: 'Stopped at approval, and nothing ran',
          change: { ...both, why, ...(detail ? { detail } : {}) },
          now,
        });
        // Tx is usable as a Database here: this commits with the close.
        await registry.get(request.action)?.afterRefusal?.(
          tx,
          request.payload,
          { detail },
          {
            actorId: request.requestedBy,
            reason: request.reason,
            now,
            services: input.services,
            facts,
          },
        );
        return { status: 'stale', why };
      };
      if (!(await requesterStillHolds(tx, request)))
        return stop('requester_lost_access');
      const outcome = await checkAndRun(tx, request, {
        actorId: request.requestedBy,
        reason: request.reason,
        now,
        approverId: actorId,
        services: input.services,
        facts,
      });
      if (!outcome.ran) return stop(outcome.why, outcome.detail);

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
      await enqueueOutbox(tx, {
        eventType: 'ops.approval_ran',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          action: request.action,
          requestedBy: request.requestedBy,
          approvedBy: actorId,
        },
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

    const ids = new Set<string>();
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
    const actorAble = await canEnterCode(db, actorId);
    // Many requests share a requester and permission, and each answer walks all the staff.
    const nobody = new Map<string, Promise<boolean>>();
    const nobodyElse = (row: ApprovalRow) => {
      const key = `${row.requestedBy}.${row.permission}.${row.action}.${JSON.stringify(row.payload)}`;
      const known = nobody.get(key);
      if (known) return known;
      const answer = qualifiedApprovers(db, {
        permission: row.permission,
        requesterId: row.requestedBy,
        action: row.action,
        payload: row.payload,
      }).then((people) => people.length === 0);
      nobody.set(key, answer);
      return answer;
    };

    const views: OpsApproval[] = [];
    for (const row of rows) {
      const open = row.status === 'pending' && now < row.expiresAt;
      const mine = row.requestedBy === actorId;
      const canDecide =
        open &&
        !mine &&
        actorAble &&
        access.permissions.has(row.permission) &&
        !(await refusalToDecide(db, {
          action: row.action,
          payload: row.payload,
          requesterId: row.requestedBy,
          decider: { userId: actorId, access },
        }));
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
        canDecide,
        nobodyElseQualified: open && (await nobodyElse(row)),
      });
    }
    return views;
  });
}
