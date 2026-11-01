import { createHash, randomBytes } from 'node:crypto';
import { newTotpSecret, otpauthUrl, verifyTotp } from '@tipme/domain';
import { and, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  auditEvents,
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
import {
  maskEmail,
  normaliseEmail,
  normaliseStaffEmail,
} from './email-address.js';
import { guarded, OperationError } from './errors.js';
import { mailOwner } from './account-mail.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
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

/**
 * Refuses a change that would leave nobody able to act as owner. Only an owner who is active, has
 * a confirmed authenticator and a live account counts. Locks those rows, so a writer outside the
 * staff-admin lock can't take the other owner away before this transaction commits.
 */
export async function assertNotLastOwner(
  tx: Tx,
  userId: string,
): Promise<void> {
  const owners = await tx
    .select({ userId: staff.userId })
    .from(staff)
    .innerJoin(staffTotp, eq(staffTotp.userId, staff.userId))
    .innerJoin(users, eq(users.id, staff.userId))
    .where(
      and(
        eq(staff.roleId, 'owner'),
        isNull(staff.revokedAt),
        isNotNull(staffTotp.confirmedAt),
        isNull(users.deletedAt),
      ),
    )
    .for('update', { of: staff });
  if (!owners.some((owner) => owner.userId !== userId))
    throw new OperationError('LAST_OWNER');
}

/**
 * For anything that moves a person's sign-in address: holds the account row and says whether they
 * are active staff. addStaff takes the same row lock, so the two can't cross. An emailed authenticator
 * reset goes to this address, so a recipient session must never be able to change it (ADR-0010).
 */
export async function lockedActiveStaff(
  tx: Tx,
  userId: string,
): Promise<boolean> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return isActiveStaff(tx, userId);
}

/** Whether this person is active staff who has never enrolled: a mere invitee. */
export async function isUnenrolledInvitee(
  tx: Database | Tx,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ enrolledAt: staff.enrolledAt })
    .from(staff)
    .where(and(eq(staff.userId, userId), isNull(staff.revokedAt)));
  return Boolean(row) && !row?.enrolledAt;
}

/**
 * Tells whoever invited them, and every owner who can act, that an invitation was turned down; and,
 * when it was declined rather than deleted away, the person, so a stolen session can't do it silently.
 */
async function mailInvitationDeclined(
  tx: Tx,
  sealing: MailSealing,
  input: {
    userId: string;
    via: 'declined' | 'account_deleted';
    roleName: string;
    now: Date;
  },
): Promise<void> {
  const [person] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.userId));
  const [invite] = await tx
    .select({ inviter: auditEvents.staffUserId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, 'staff.added'),
        eq(auditEvents.subjectId, input.userId),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const recipients = await tx
    .select({ userId: users.id, email: users.email, roleId: staff.roleId })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .innerJoin(staffTotp, eq(staffTotp.userId, staff.userId))
    .where(
      and(
        isNull(staff.revokedAt),
        isNotNull(staffTotp.confirmedAt),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
        ne(staff.userId, input.userId),
      ),
    );
  for (const recipient of recipients)
    if (
      recipient.email &&
      (recipient.roleId === 'owner' || recipient.userId === invite?.inviter)
    )
      await enqueueMail(tx, sealing, {
        type: 'staff_invitation_declined',
        to: recipient.email,
        userId: recipient.userId,
        data: {
          personHint: person?.email ? maskEmail(person.email) : 'Someone',
          roleName: input.roleName,
        },
        dedupeKey: `staff_invitation_declined.${input.userId}.${recipient.userId}.${newId()}`,
        now: input.now,
      });
  if (input.via === 'declined')
    await mailOwner(tx, sealing, {
      userId: input.userId,
      type: 'staff_invitation_declined',
      data: {
        personHint: person?.email ? maskEmail(person.email) : 'Someone',
        roleName: input.roleName,
        own: true,
      },
      dedupeKey: `staff_invitation_declined.${input.userId}.own.${newId()}`,
      now: input.now,
    });
}

/**
 * Ends the staff access of a mere invitee, at their own request: they never had the use of it, so
 * they need nobody's say-so. The caller holds the staff-admin lock. The update is conditional on
 * the marker, so a confirmation committing at this moment wins.
 */
export async function revokeUnenrolled(
  tx: Tx,
  input: {
    userId: string;
    via: 'declined' | 'account_deleted';
    sealing: MailSealing;
    now: Date;
  },
): Promise<void> {
  const { userId, via, now } = input;
  const [row] = await tx
    .update(staff)
    .set({ revokedAt: now })
    .where(
      and(
        eq(staff.userId, userId),
        isNull(staff.revokedAt),
        isNull(staff.enrolledAt),
      ),
    )
    .returning({ roleId: staff.roleId });
  // A confirmation got in first: refused in the terms of what was asked for.
  if (!row)
    throw new OperationError(
      via === 'account_deleted'
        ? 'STAFF_CANNOT_DELETE'
        : 'STAFF_ALREADY_ENROLLED',
    );
  const [role] = await tx
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.id, row.roleId));
  await dropOpsAccess(tx, userId, now);
  const cleared = await clearOverrides(tx, userId);
  await recordAudit(tx, {
    staffUserId: userId,
    action: 'staff.invitation_declined',
    subjectType: 'user',
    subjectId: userId,
    reason: withAuditChange('Declined by the person themselves', {
      via,
      role,
      ...cleared,
    }),
    now,
  });
  await mailInvitationDeclined(tx, input.sealing, {
    userId,
    via,
    roleName: role?.name ?? row.roleId,
    now,
  });
}

/**
 * An invited person turning it down, from their own session. Their account stays. Only for someone
 * who has never enrolled: anyone who has is an owner's decision, even mid-reset.
 */
export function declineInvitation(
  db: Database,
  input: { userId: string; sealing: MailSealing; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      await lockStaffAdmin(tx);
      if (!(await lockedActiveStaff(tx, input.userId)))
        throw new OperationError('STAFF_NOT_FOUND');
      await revokeUnenrolled(tx, {
        userId: input.userId,
        via: 'declined',
        sealing: input.sealing,
        now,
      });
    }),
  );
}

/** Uses up any open enrolment code. */
export async function voidEnrolments(
  tx: Database | Tx,
  userId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(staffEnrolments)
    .set({ usedAt: now })
    .where(
      and(eq(staffEnrolments.userId, userId), isNull(staffEnrolments.usedAt)),
    );
}

/**
 * Replaces any open enrolment code with a new one, valid for 30 minutes, and clears a lockout so
 * it can be used at once. Only its SHA-256 is stored; the caller hands the code to the person and
 * nowhere else.
 */
export async function issueEnrolment(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  await voidEnrolments(tx, userId, now);
  const code = Array.from(randomBytes(10), (byte) => BASE32[byte & 31]).join(
    '',
  );
  const expiresAt = new Date(now.getTime() + ENROLMENT_TTL_MS);
  await tx
    .insert(staffEnrolments)
    .values({ codeSha256: sha256(code), userId, expiresAt });
  await tx.delete(opsLockouts).where(eq(opsLockouts.userId, userId));
  return { code, expiresAt };
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
 * Voids open enrolment links, removes the authenticator and ends every admin grant. Runs on any
 * number move (phone change, completed recovery) so a moved account must be granted again; a no-op
 * for non-staff. Links go first, so one being used right now can't leave its secret behind.
 */
export async function dropOpsAccess(
  tx: Database | Tx,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await voidEnrolments(tx, userId, now);
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
        .select({ id: users.id, email: users.email })
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
        )
        .for('update');
      const named = email ?? existing?.email;
      if (named) {
        // One person, one staff account: naming a variant must not quietly make a second one. An
        // account already active is who the operator means, whatever a removed look-alike held.
        const mailbox = normaliseStaffEmail(named);
        const staffAccounts = await tx
          .select({
            userId: staff.userId,
            email: users.email,
            revokedAt: staff.revokedAt,
          })
          .from(staff)
          .innerJoin(users, eq(users.id, staff.userId));
        const active = staffAccounts.some(
          (person) => person.userId === existing?.id && !person.revokedAt,
        );
        const match = staffAccounts.find(
          (person) =>
            person.userId !== existing?.id &&
            person.email &&
            normaliseStaffEmail(person.email) === mailbox &&
            !(active && person.revokedAt),
        );
        if (match?.email)
          throw new OperationError('STAFF_EMAIL_TAKEN', maskEmail(match.email));
      }
      const userId = existing?.id ?? newId();
      const [previous] = existing
        ? await tx
            .select({ roleId: staff.roleId, revokedAt: staff.revokedAt })
            .from(staff)
            .where(eq(staff.userId, userId))
        : [];
      // Break-glass may restore anyone, but must not itself be what leaves no owner.
      if (
        role !== 'owner' &&
        previous?.roleId === 'owner' &&
        !previous.revokedAt
      )
        await assertNotLastOwner(tx, userId);
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
          // Coming back after removal starts over; a lost phone or a repeat keeps the marker.
          set: {
            roleId: role,
            grantedAt: now,
            revokedAt: null,
            ...(previous?.revokedAt ? { enrolledAt: null } : {}),
          },
        });
      await dropOpsAccess(tx, userId, now);
      const { code: enrolmentCode } = await issueEnrolment(tx, userId, now);
      // Neither built-in role uses adjustments, and they must not return on a later move.
      const cleared = await clearOverrides(tx, userId);
      await recordAudit(tx, {
        staffUserId: null,
        action:
          role === 'owner'
            ? 'staff.owner_granted'
            : 'staff.release_check_granted',
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange('Granted from the server', {
          from: previous?.roleId ?? null,
          to: role,
          restored: Boolean(previous?.revokedAt),
          ...cleared,
        }),
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

/**
 * Takes a person's rows in the order everything that ends their access does: account, then staff,
 * and only then enrolment links and the authenticator. The account is only shared, as the writes
 * naming it would share it anyway: taken late, that share would wait on a decline or deletion
 * already holding the account and waiting on these rows.
 */
async function lockPersonForAuthenticator(
  tx: Tx,
  userId: string,
): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('key share');
  await tx
    .select({ userId: staff.userId })
    .from(staff)
    .where(eq(staff.userId, userId))
    .for('update');
}

/** Uses up the enrolment code and stores a new sealed authenticator secret (not yet confirmed). */
export function startTotpEnrolment(
  db: Database,
  input: { userId: string; enrolmentCode: string; key: Buffer; now?: Date },
): Promise<{ secret: string; otpauthUrl: string }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      await lockPersonForAuthenticator(tx, input.userId);
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
  await lockPersonForAuthenticator(tx, input.userId);
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
  if (!row.confirmedAt)
    await tx
      .update(staff)
      .set({ enrolledAt: input.now })
      .where(and(eq(staff.userId, input.userId), isNull(staff.enrolledAt)));
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
