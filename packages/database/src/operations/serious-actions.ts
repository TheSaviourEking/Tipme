import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  approvalRequests,
  OPS_PERMISSIONS,
  staff,
  staffTotp,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { normaliseStaffEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { enqueueOutbox } from './outbox.js';
import {
  canonicalId,
  checkedReason,
  lockStaffAdmin,
  readStaffAccess,
  withAuditChange,
} from './staff.js';

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(OPS_PERMISSIONS);

export interface SeriousActionContext {
  actorId: string;
  reason: string;
  now: Date;
}

/** A catalogue action: how to check it, how to say exactly what changes, and how to run it. */
export interface SeriousActionDefinition<Payload> {
  name: string;
  permission: string;
  /** Throws an OperationError if the facts don't allow it. */
  validate(tx: Tx, payload: Payload): Promise<void>;
  /** Shown to the approver and kept in the log, so server-chosen words, no private details. */
  describe(tx: Tx, payload: Payload): Promise<string>;
  run(tx: Tx, payload: Payload, ctx: SeriousActionContext): Promise<void>;
}

export type SeriousActionOutcome =
  | { state: 'ran'; aloneReason: 'no_second_person' }
  | { state: 'pending'; requestId: string };

const registry = new Map<string, SeriousActionDefinition<unknown>>();

export function registerSeriousAction<Payload>(
  action: SeriousActionDefinition<Payload>,
): void {
  if (registry.has(action.name))
    throw new Error(`${action.name} is already registered`);
  if (!KNOWN_PERMISSIONS.has(action.permission))
    throw new Error(`${action.name} names an unknown permission`);
  // Each action defines its own payload; what comes back to it is what it was given.
  registry.set(action.name, action as SeriousActionDefinition<unknown>);
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
 * itself once someone qualifies. The route has already asked for a fresh code.
 *
 * Who qualifies is decided under the staff-admin lock, so a staff change in flight is seen rather
 * than missed. That lock comes first, as in every staff-admin path.
 */
export function requestSeriousAction(
  db: Database,
  input: {
    name: string;
    payload: unknown;
    actorId: string;
    reason: string;
    now?: Date;
  },
): Promise<SeriousActionOutcome> {
  return guarded(async () => {
    const action = registry.get(input.name);
    if (!action) throw new OperationError('INVALID_INPUT');
    const reason = checkedReason(input.reason);
    const now = input.now ?? new Date();
    return db.transaction(async (tx): Promise<SeriousActionOutcome> => {
      await lockStaffAdmin(tx);
      const actorId = canonicalId(input.actorId);
      const access = actorId ? await readStaffAccess(tx, actorId) : null;
      if (
        !actorId ||
        !access?.permissions.has(action.permission) ||
        !(await canEnterCode(tx, actorId))
      )
        throw new OperationError('PERMISSION_NOT_HELD');

      await action.validate(tx, input.payload);
      const summary = await action.describe(tx, input.payload);
      const approvers = await qualifiedApprovers(tx, {
        permission: action.permission,
        requesterId: actorId,
      });

      if (approvers.length > 0) {
        const requestId = newId();
        await tx.insert(approvalRequests).values({
          id: requestId,
          action: action.name,
          payload: input.payload,
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

      await action.run(tx, input.payload, { actorId, reason, now });
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
      return { state: 'ran', aloneReason: 'no_second_person' };
    });
  });
}
