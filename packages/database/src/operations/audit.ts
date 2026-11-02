import { desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { OpsStaffActivity } from '@tipme/contracts';
import type { Database, Tx } from '../client.js';
import { auditEvents, users } from '../schema.js';
import { maskEmail } from './email-address.js';
import { guarded } from './errors.js';
import { activeTraceId, newId } from './ids.js';

export interface AuditInput {
  databaseClock?: boolean;
  /** null when the system acted (for example an issue resolving itself). */
  staffUserId: string | null;
  action: string;
  permission?: string;
  subjectType?: string;
  subjectId?: string;
  reason?: string;
  traceId?: string;
  now?: Date;
}

/** Writes one audit row; pass the transaction so the action and its record commit together. */
export async function recordAudit(
  tx: Database | Tx,
  input: AuditInput,
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: newId(),
    staffUserId: input.staffUserId,
    action: input.action,
    permission: input.permission ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    reason: input.reason ?? null,
    traceId: input.traceId ?? activeTraceId(),
    // When a later check compares this with a time the database set, both must come from it.
    createdAt: input.databaseClock
      ? sql`clock_timestamp()`
      : (input.now ?? new Date()),
  });
}

/** Spec 6.4's alerts, as the Overview shows them. */
const STAFF_ACTIVITY_ACTIONS = [
  'staff.added',
  'staff.removed',
  'staff.role_changed',
  'staff.access_changed',
  'staff.authenticator_reset',
  'staff.invitation_declined',
  'role.created',
  'role.updated',
  'role.deleted',
  'serious_action.ran',
  'serious_action.ran_alone',
  'serious_action.rejected',
  'serious_action.stale',
  'withdrawals.released',
  'withdrawals.freeze_lifted',
];

/** Newest first. The written reason stays in the audit log, which takes its own permission. */
export function staffActivity(
  db: Database,
  input: { limit: number },
): Promise<OpsStaffActivity[]> {
  return guarded(async () => {
    const rows = await db
      .select({
        seq: auditEvents.seq,
        action: auditEvents.action,
        staffUserId: auditEvents.staffUserId,
        subjectId: auditEvents.subjectId,
        createdAt: auditEvents.createdAt,
        email: users.email,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.staffUserId))
      .where(inArray(auditEvents.action, STAFF_ACTIVITY_ACTIONS))
      .orderBy(desc(auditEvents.seq))
      .limit(input.limit);
    return rows.map((row) => ({
      seq: row.seq,
      action: row.action,
      staffUserId: row.staffUserId,
      staffHint: row.email ? maskEmail(row.email) : null,
      seriousAction:
        row.action === 'serious_action.ran_alone' ? row.subjectId : null,
      at: row.createdAt.toISOString(),
    }));
  });
}

export interface AuditRow {
  seq: number;
  staffUserId: string | null;
  action: string;
  permission: string | null;
  subjectType: string | null;
  subjectId: string | null;
  reason: string | null;
  traceId: string | null;
  createdAt: string;
}

/** Newest first; `cursor` is the `seq` of the last row already shown. */
export function listAudit(
  db: Database,
  input: { cursor?: number; limit: number },
): Promise<AuditRow[]> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        input.cursor === undefined
          ? undefined
          : lt(auditEvents.seq, input.cursor),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(Math.min(Math.max(input.limit, 1), 100));
    return rows.map((row) => ({
      seq: row.seq,
      staffUserId: row.staffUserId,
      action: row.action,
      permission: row.permission,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      reason: row.reason,
      traceId: row.traceId,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}
