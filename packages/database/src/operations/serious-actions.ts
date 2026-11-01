import { OPS_CATALOGUE, type OpsPermission } from '@tipme/contracts';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, staff, staffTotp, users } from '../schema.js';
import { recordAudit } from './audit.js';
import { normaliseStaffEmail } from './email-address.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import { assertFreshCode } from './ops-sessions.js';
import { enqueueOutbox } from './outbox.js';
import {
  canonicalId,
  checkedReason,
  lockStaffAdmin,
  readStaffAccess,
  withAuditChange,
} from './staff.js';

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_TIMEOUT = '10s';
// Names that say a value is a credential. Requests sit in the clear for approvers and the log.
const SECRET_KEY = /(code|token|secret)$/i;

export interface SeriousActionContext {
  actorId: string;
  reason: string;
  now: Date;
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
   * handed back for the route's normal response.
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
    if (sqlStateOf(error) === '57014')
      throw new OperationError('STAFF_ADMIN_BUSY');
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
    const candidates = await db
      .select({ userId: staff.userId, email: users.email })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .innerJoin(staffTotp, eq(staffTotp.userId, staff.userId))
      .where(
        and(
          isNull(staff.revokedAt),
          isNotNull(staffTotp.confirmedAt),
          isNull(users.deletedAt),
        ),
      );
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
 * alone with its alert, which fails towards visible. Identical pending requests aren't deduped here.
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
        return { state: 'pending', requestId };
      }

      const result = await runWithinTime(tx, () =>
        action.run(tx, payload, { actorId, reason, now }),
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
