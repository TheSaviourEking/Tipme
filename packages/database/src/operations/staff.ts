import { createHash, randomBytes } from 'node:crypto';
import { newTotpSecret, otpauthUrl, verifyTotp } from '@tipme/domain';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  OPS_PERMISSIONS,
  opsLockouts,
  opsSessions,
  rolePermissions,
  roles,
  staff,
  staffEnrolments,
  staffTotp,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { normalisePhone, phoneHint } from './phone.js';
import { openSecret, sealSecret } from './secret-box.js';

const ENROLMENT_TTL_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** The Owner role holds every permission; safe to run any number of times. */
export async function ensureOwnerRole(tx: Database | Tx): Promise<void> {
  await tx
    .insert(roles)
    .values({ id: 'owner', name: 'Owner' })
    .onConflictDoNothing();
  await tx
    .insert(rolePermissions)
    .values(
      OPS_PERMISSIONS.map((permission) => ({ roleId: 'owner', permission })),
    )
    .onConflictDoNothing();
}

/** Whether the account currently holds a staff role. */
export async function isActiveStaff(
  tx: Database | Tx,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ userId: staff.userId })
    .from(staff)
    .where(and(eq(staff.userId, userId), isNull(staff.revokedAt)));
  return Boolean(row);
}

/** The permissions of an active staff member, or null for everyone else. */
export function staffPermissions(
  db: Database | Tx,
  userId: string,
): Promise<Set<string> | null> {
  return guarded(async () => {
    if (!(await isActiveStaff(db, userId))) return null;
    const rows = await db
      .select({ permission: rolePermissions.permission })
      .from(staff)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, staff.roleId))
      .where(eq(staff.userId, userId));
    return new Set(rows.map((row) => row.permission));
  });
}

/** The role id of an active staff member, or null. */
export function staffRole(
  db: Database,
  userId: string,
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ roleId: staff.roleId })
      .from(staff)
      .where(and(eq(staff.userId, userId), isNull(staff.revokedAt)));
    return row?.roleId ?? null;
  });
}

/**
 * Removes the authenticator and ends every admin grant. Runs on any number move (phone change,
 * completed recovery) so a moved account must be granted again; a no-op for non-staff.
 */
export async function dropOpsAccess(
  tx: Database | Tx,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.delete(staffTotp).where(eq(staffTotp.userId, userId));
  await tx
    .update(opsSessions)
    .set({ revokedAt: now })
    .where(and(eq(opsSessions.userId, userId), isNull(opsSessions.revokedAt)));
}

/**
 * `pnpm ops:grant-owner`: makes the account behind a phone number the Owner and returns a one-time
 * enrolment code (30 minutes). Any earlier authenticator is removed, so this is also re-enrolment.
 */
export function grantOwner(
  db: Database,
  input: { phone: string; now?: Date },
): Promise<{ userId: string; enrolmentCode: string }> {
  const phone = normalisePhone(input.phone);
  if (!phone) return Promise.reject(new OperationError('INVALID_INPUT'));
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      await ensureOwnerRole(tx);
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.phoneE164, phone), isNull(users.deletedAt)));
      const userId = existing?.id ?? newId();
      if (!existing)
        await tx.insert(users).values({ id: userId, phoneE164: phone });
      await tx
        .insert(staff)
        .values({ userId, roleId: 'owner', grantedAt: now })
        .onConflictDoUpdate({
          target: staff.userId,
          set: { roleId: 'owner', grantedAt: now, revokedAt: null },
        });
      await dropOpsAccess(tx, userId, now);
      await tx
        .update(staffEnrolments)
        .set({ usedAt: now })
        .where(
          and(
            eq(staffEnrolments.userId, userId),
            isNull(staffEnrolments.usedAt),
          ),
        );
      const enrolmentCode = Array.from(
        randomBytes(10),
        (byte) => BASE32[byte & 31],
      ).join('');
      await tx.insert(staffEnrolments).values({
        codeSha256: sha256(enrolmentCode),
        userId,
        expiresAt: new Date(now.getTime() + ENROLMENT_TTL_MS),
      });
      await recordAudit(tx, {
        staffUserId: null,
        action: 'staff.owner_granted',
        subjectType: 'user',
        subjectId: userId,
        now,
      });
      return { userId, enrolmentCode };
    }),
  );
}

/** Uses up the enrolment code and stores a new sealed authenticator secret (not yet confirmed). */
export function startTotpEnrolment(
  db: Database,
  input: { userId: string; enrolmentCode: string; key: Buffer; now?: Date },
): Promise<{ secret: string; otpauthUrl: string }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!(await isActiveStaff(tx, input.userId)))
        throw new OperationError('ENROLMENT_INVALID');
      const used = await tx
        .update(staffEnrolments)
        .set({ usedAt: now })
        .where(
          and(
            eq(
              staffEnrolments.codeSha256,
              sha256(input.enrolmentCode.trim().toUpperCase()),
            ),
            eq(staffEnrolments.userId, input.userId),
            isNull(staffEnrolments.usedAt),
            gt(staffEnrolments.expiresAt, now),
          ),
        )
        .returning({ userId: staffEnrolments.userId });
      if (used.length === 0) throw new OperationError('ENROLMENT_INVALID');
      const secret = newTotpSecret();
      const secretEnc = sealSecret(input.key, secret);
      await tx
        .insert(staffTotp)
        .values({ userId: input.userId, secretEnc })
        .onConflictDoUpdate({
          target: staffTotp.userId,
          set: { secretEnc, confirmedAt: null, lastStep: null },
        });
      const [user] = await tx
        .select({ phone: users.phoneE164 })
        .from(users)
        .where(eq(users.id, input.userId));
      return {
        secret,
        otpauthUrl: otpauthUrl(
          secret,
          user?.phone ? phoneHint(user.phone) : 'staff',
        ),
      };
    }),
  );
}

export type CodeCheck = 'ok' | 'invalid' | 'locked';

async function isLocked(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ lockedUntil: opsLockouts.lockedUntil })
    .from(opsLockouts)
    .where(eq(opsLockouts.userId, userId));
  return Boolean(row?.lockedUntil && row.lockedUntil > now);
}

/** Counts a wrong code; the fifth in a row locks ops access for 15 minutes. */
async function failure(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<'invalid' | 'locked'> {
  const [row] = await tx
    .insert(opsLockouts)
    .values({ userId, failures: 1 })
    .onConflictDoUpdate({
      target: opsLockouts.userId,
      set: { failures: sql`${opsLockouts.failures} + 1` },
    })
    .returning({ failures: opsLockouts.failures });
  if ((row?.failures ?? 0) < MAX_FAILURES) return 'invalid';
  await tx
    .update(opsLockouts)
    .set({ failures: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) })
    .where(eq(opsLockouts.userId, userId));
  return 'locked';
}

/**
 * Checks an authenticator code under a row lock and records its step, so the same code can never
 * be used twice, even by two requests at once.
 */
export async function checkStaffCode(
  tx: Tx,
  input: {
    userId: string;
    code: string;
    key: Buffer;
    now: Date;
    confirmed: boolean;
  },
): Promise<CodeCheck | 'not_enrolled'> {
  if (await isLocked(tx, input.userId, input.now)) return 'locked';
  const [row] = await tx
    .select()
    .from(staffTotp)
    .where(eq(staffTotp.userId, input.userId))
    .for('update');
  if (!row || Boolean(row.confirmedAt) !== input.confirmed)
    return 'not_enrolled';
  const result = verifyTotp(
    openSecret(input.key, row.secretEnc),
    input.code,
    input.now,
    row.lastStep,
  );
  if (!result.ok) return failure(tx, input.userId, input.now);
  await tx
    .update(staffTotp)
    .set({ lastStep: result.step, confirmedAt: row.confirmedAt ?? input.now })
    .where(eq(staffTotp.userId, input.userId));
  await tx.delete(opsLockouts).where(eq(opsLockouts.userId, input.userId));
  return 'ok';
}

/** Confirms a just-started enrolment with the first code from the app. */
export function confirmTotpEnrolment(
  db: Database,
  input: { userId: string; code: string; key: Buffer; now?: Date },
): Promise<{ status: CodeCheck }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!(await isActiveStaff(tx, input.userId)))
        return { status: 'invalid' as const };
      const result = await checkStaffCode(tx, {
        ...input,
        now,
        confirmed: false,
      });
      if (result === 'ok')
        await recordAudit(tx, {
          staffUserId: input.userId,
          action: 'ops.authenticator_enrolled',
          subjectType: 'user',
          subjectId: input.userId,
          now,
        });
      return {
        status: result === 'not_enrolled' ? ('invalid' as const) : result,
      };
    }),
  );
}
export { OPS_PERMISSIONS, type OpsPermission } from '../schema.js';
