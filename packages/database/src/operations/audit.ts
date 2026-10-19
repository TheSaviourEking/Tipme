import { desc, lt } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { auditEvents } from '../schema.js';
import { guarded } from './errors.js';
import { activeTraceId, newId } from './ids.js';

export interface AuditInput {
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
    createdAt: input.now ?? new Date(),
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
