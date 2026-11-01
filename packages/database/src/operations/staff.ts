import { createHash, randomBytes } from 'node:crypto';
import { newTotpSecret, otpauthUrl, verifyTotp } from '@tipme/domain';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  OPS_PERMISSIONS,
  type OpsPermission,
  opsLockouts,
  opsSessions,
  rolePermissions,
  roles,
  staff,
  staffEnrolments,
  staffPermissionOverrides,
  staffTotp,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { normaliseEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';
import { mailOwner } from './account-mail.js';
import type { MailSealing } from './mail-queue.js';
import { newId } from './ids.js';
import { normalisePhone, phoneHint } from './phone.js';
import { openSecret, sealSecret } from './secret-box.js';

const ENROLMENT_TTL_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** The release check's own account: it may read and resolve issues and read numbers (PR-010). */
export const RELEASE_CHECK_PERMISSIONS = [
  'issues.view',
  'issues.resolve',
  'analytics.view',
  'audit.view',
] as const satisfies readonly OpsPermission[];
export type StaffRole = 'owner' | 'release_check';

/** The Owner role holds every permission; safe to run any number of times. */
export async function ensureOwnerRole(tx: Database | Tx): Promise<void> {
  await tx
    .insert(roles)
    .values({ id: 'owner', name: 'Owner', system: true })
    .onConflictDoNothing();
  await tx
    .insert(rolePermissions)
    .values(
      OPS_PERMISSIONS.map((permission) => ({ roleId: 'owner', permission })),
    )
    .onConflictDoNothing();
}

async function ensureReleaseCheckRole(tx: Database | Tx): Promise<void> {
  await tx
    .insert(roles)
    .values({ id: 'release_check', name: 'Release check', system: true })
    .onConflictDoNothing();
  await tx
    .insert(rolePermissions)
    .values(
      RELEASE_CHECK_PERMISSIONS.map((permission) => ({
        roleId: 'release_check',
        permission,
      })),
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

/**
 * Serialises every change to who holds what, for the rest of the transaction. Take it first, and
 * read anything the change depends on after it.
 */
export async function lockStaffAdmin(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
  );
}

const AUDIT_CHANGE_MARKER = '[change:';

/** The server's record of a change, after the person's reason. `change` is data, encoded as JSON. */
export const withAuditChange = (reason: string, change: object): string =>
  `${reason} ${AUDIT_CHANGE_MARKER} ${JSON.stringify(change)}]`;

/** Whether text could pass for that record; compared as a reader would see it. */
export const looksLikeAuditChange = (text: string): boolean =>
  text.normalize('NFKC').toLowerCase().includes(AUDIT_CHANGE_MARKER);

export interface StaffAccess {
  roleId: string;
  permissions: Set<string>;
  additions: string[];
  removals: string[];
}

/** Adjustments never apply to the built-in roles: owner has everything, release_check is fixed. */
export const ignoresAdjustments = (roleId: string): boolean =>
  roleId === 'owner' || roleId === 'release_check';

/** Effective access: the role's permissions, plus personal additions, minus personal removals. */
export function composeAccess(
  roleId: string,
  rolePermissionNames: readonly string[],
  overrides: readonly { permission: string; effect: string }[],
): StaffAccess {
  // Owner comes from the catalogue, not stored rows, so it holds future permissions too.
  if (roleId === 'owner')
    return {
      roleId,
      permissions: new Set(OPS_PERMISSIONS),
      additions: [],
      removals: [],
    };
  if (ignoresAdjustments(roleId))
    return {
      roleId,
      permissions: new Set(rolePermissionNames),
      additions: [],
      removals: [],
    };
  const additions = overrides
    .filter((row) => row.effect === 'add')
    .map((row) => row.permission)
    .sort();
  const removals = overrides
    .filter((row) => row.effect === 'remove')
    .map((row) => row.permission)
    .sort();
  const permissions = new Set([...rolePermissionNames, ...additions]);
  for (const permission of removals) permissions.delete(permission);
  return { roleId, permissions, additions, removals };
}

/** A person's stored adjustments, whether or not their current role applies them. */
export function readOverrides(
  db: Database | Tx,
  userId: string,
): Promise<{ permission: string; effect: string }[]> {
  return db
    .select({
      permission: staffPermissionOverrides.permission,
      effect: staffPermissionOverrides.effect,
    })
    .from(staffPermissionOverrides)
    .where(eq(staffPermissionOverrides.userId, userId));
}

/** Deletes a person's adjustments and says what they were. */
export async function clearOverrides(
  tx: Tx,
  userId: string,
): Promise<{ clearedAdditions: string[]; clearedRemovals: string[] }> {
  const rows = await tx
    .delete(staffPermissionOverrides)
    .where(eq(staffPermissionOverrides.userId, userId))
    .returning({
      permission: staffPermissionOverrides.permission,
      effect: staffPermissionOverrides.effect,
    });
  const named = (effect: string) =>
    rows
      .filter((row) => row.effect === effect)
      .map((row) => row.permission)
      .sort();
  return { clearedAdditions: named('add'), clearedRemovals: named('remove') };
}

/** The permission names stored on a role. */
export async function readRolePermissions(
  db: Database | Tx,
  roleId: string,
): Promise<string[]> {
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.permission);
}

/** Read from the database every time, so a change applies on the person's next request. */
export async function readStaffAccess(
  db: Database | Tx,
  userId: string,
): Promise<StaffAccess | null> {
  const [row] = await db
    .select({ roleId: staff.roleId })
    .from(staff)
    .where(and(eq(staff.userId, userId), isNull(staff.revokedAt)));
  if (!row) return null;
  const [names, overrides] = [
    await readRolePermissions(db, row.roleId),
    await readOverrides(db, userId),
  ];
  return composeAccess(row.roleId, names, overrides);
}

/** The permissions of an active staff member, or null for everyone else. */
export function staffPermissions(
  db: Database | Tx,
  userId: string,
): Promise<Set<string> | null> {
  return guarded(
    async () => (await readStaffAccess(db, userId))?.permissions ?? null,
  );
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
  input: {
    /** The account's sign-in email; or a phone, while phone sign-in exists in pretend mode. */
    email?: string;
    phone?: string;
    now?: Date;
    role?: StaffRole;
    /** Absent only where the operator's command has no mail key: the email is then skipped. */
    sealing?: MailSealing;
  },
): Promise<{ userId: string; enrolmentCode: string }> {
  const email = input.email ? normaliseEmail(input.email) : null;
  const phone = input.phone ? normalisePhone(input.phone) : null;
  if (!email && !phone)
    return Promise.reject(new OperationError('INVALID_INPUT'));
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      // Break-glass, but still one change among the others: it waits its turn.
      await lockStaffAdmin(tx);
      await ensureOwnerRole(tx);
      await ensureReleaseCheckRole(tx);
      const role = input.role ?? 'owner';
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            email
              ? and(
                  sql`lower(${users.email}) = ${email}`,
                  isNotNull(users.emailVerifiedAt),
                )
              : eq(users.phoneE164, phone!),
            isNull(users.deletedAt),
          ),
        );
      const userId = existing?.id ?? newId();
      // The person running this names the address; signing in still needs a code sent to it.
      if (!existing)
        await tx
          .insert(users)
          .values(
            email
              ? { id: userId, email, emailVerifiedAt: now }
              : { id: userId, phoneE164: phone! },
          );
      await tx
        .insert(staff)
        .values({ userId, roleId: role, grantedAt: now })
        .onConflictDoUpdate({
          target: staff.userId,
          set: { roleId: role, grantedAt: now, revokedAt: null },
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
      // An owner's adjustments mean nothing now, and must not return if they are later demoted.
      const cleared =
        role === 'owner' ? await clearOverrides(tx, userId) : null;
      await recordAudit(tx, {
        staffUserId: null,
        action:
          role === 'owner'
            ? 'staff.owner_granted'
            : 'staff.release_check_granted',
        subjectType: 'user',
        subjectId: userId,
        ...(cleared &&
        cleared.clearedAdditions.length + cleared.clearedRemovals.length > 0
          ? { reason: withAuditChange('Granted from the server', cleared) }
          : {}),
        now,
      });
      if (input.sealing)
        await mailOwner(tx, input.sealing, {
          userId,
          type: 'staff_access_notice',
          data: { change: 'granted' },
          dedupeKey: `staff_access_notice.${userId}.${now.getTime()}`,
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
  // Lock first, then read the lockout: parallel guesses queue here and each sees the lockout
  // set by the ones before it (final review fix).
  const [row] = await tx
    .select()
    .from(staffTotp)
    .where(eq(staffTotp.userId, input.userId))
    .for('update');
  if (!row || Boolean(row.confirmedAt) !== input.confirmed)
    return 'not_enrolled';
  if (await isLocked(tx, input.userId, input.now)) return 'locked';
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
