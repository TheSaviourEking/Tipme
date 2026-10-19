import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { opsSessions, sessions, staffTotp } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { checkStaffCode, isActiveStaff, staffPermissions } from './staff.js';

export const OPS_GRANT_TTL_MS = 12 * 60 * 60 * 1000;
export const OPS_GRANT_IDLE_MS = 60 * 60 * 1000;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type OpenGrantResult =
  | { status: 'ok'; token: string; expiresAt: Date }
  | { status: 'invalid' | 'locked' | 'not_staff' };

/**
 * Opens an admin grant after an authenticator code, bound to the recipient session it was opened
 * from: signing out or revoking that session ends the grant too.
 */
export function openOpsGrant(
  db: Database,
  input: {
    userId: string;
    sessionId: string;
    code: string;
    key: Buffer;
    now?: Date;
  },
): Promise<OpenGrantResult> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx): Promise<OpenGrantResult> => {
      if (!(await isActiveStaff(tx, input.userId)))
        return { status: 'not_staff' };
      const check = await checkStaffCode(tx, {
        ...input,
        now,
        confirmed: true,
      });
      if (check === 'not_enrolled') return { status: 'not_staff' };
      if (check !== 'ok') return { status: check };
      return {
        status: 'ok',
        ...(await insertGrant(tx, input.userId, input.sessionId, now)),
      };
    }),
  );
}

async function insertGrant(
  tx: Tx,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + OPS_GRANT_TTL_MS);
  const id = newId();
  await tx.insert(opsSessions).values({
    id,
    userId,
    sessionId,
    tokenSha256: hashToken(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  await recordAudit(tx, {
    staffUserId: userId,
    action: 'ops.grant_opened',
    subjectType: 'ops_session',
    subjectId: id,
    now,
  });
  return { token, expiresAt };
}

/**
 * Confirms a new authenticator with its first code and opens a grant in the same step (the code is
 * then used up, so asking for a second one straight away would mean waiting for the next step).
 */
export function confirmEnrolmentAndOpenGrant(
  db: Database,
  input: {
    userId: string;
    sessionId: string;
    code: string;
    key: Buffer;
    now?: Date;
  },
): Promise<OpenGrantResult> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx): Promise<OpenGrantResult> => {
      if (!(await isActiveStaff(tx, input.userId)))
        return { status: 'not_staff' };
      const check = await checkStaffCode(tx, {
        ...input,
        now,
        confirmed: false,
      });
      if (check === 'not_enrolled') return { status: 'invalid' };
      if (check !== 'ok') return { status: check };
      await recordAudit(tx, {
        staffUserId: input.userId,
        action: 'ops.authenticator_enrolled',
        subjectType: 'user',
        subjectId: input.userId,
        now,
      });
      return {
        status: 'ok',
        ...(await insertGrant(tx, input.userId, input.sessionId, now)),
      };
    }),
  );
}

/** The staff member behind a live grant on this recipient session, or null. Use slides the idle hour. */
export function resolveOpsGrant(
  db: Database,
  input: { token: string; sessionId: string; now?: Date },
): Promise<{ userId: string; permissions: Set<string> } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return Promise.resolve(null);
  const now = input.now ?? new Date();
  return guarded(async () => {
    const [row] = await db
      .select({ id: opsSessions.id, userId: opsSessions.userId })
      .from(opsSessions)
      .innerJoin(sessions, eq(sessions.id, opsSessions.sessionId))
      .where(
        and(
          eq(opsSessions.tokenSha256, hashToken(input.token)),
          eq(opsSessions.sessionId, input.sessionId),
          isNull(opsSessions.revokedAt),
          gt(opsSessions.expiresAt, now),
          gt(
            opsSessions.lastSeenAt,
            new Date(now.getTime() - OPS_GRANT_IDLE_MS),
          ),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      );
    if (!row) return null;
    const permissions = await staffPermissions(db, row.userId);
    if (!permissions) return null;
    await db
      .update(opsSessions)
      .set({ lastSeenAt: now })
      .where(eq(opsSessions.id, row.id));
    return { userId: row.userId, permissions };
  });
}

/** Ends this staff member's grants (admin sign-out). */
export async function revokeOpsGrants(
  tx: Database | Tx,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(opsSessions)
    .set({ revokedAt: now })
    .where(and(eq(opsSessions.userId, userId), isNull(opsSessions.revokedAt)));
}

/** Whether this account is staff and has a confirmed authenticator (drives the admin sign-in step). */
export function opsEnrolmentState(
  db: Database,
  userId: string,
): Promise<'not_staff' | 'needs_enrolment' | 'enrolled'> {
  return guarded(async () => {
    if (!(await isActiveStaff(db, userId))) return 'not_staff';
    const [row] = await db
      .select({ confirmedAt: staffTotp.confirmedAt })
      .from(staffTotp)
      .where(eq(staffTotp.userId, userId));
    const confirmed = Boolean(row?.confirmedAt);
    return confirmed ? 'enrolled' : 'needs_enrolment';
  });
}
