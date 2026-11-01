import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  emailRecoveries,
  mailMessages,
  mailSuppressions,
  OPS_PERMISSIONS,
  phoneRecoveries,
  rolePermissions,
  roles,
  staff,
  staffEnrolments,
  staffPermissionOverrides,
  staffTotp,
  users,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { recordAudit } from './audit.js';
import {
  maskEmail,
  normaliseEmail,
  normaliseStaffEmail,
} from './email-address.js';
import { mailRecoveryCancelled } from './email-recovery.js';
import { verifiedOwner } from './email-sign-in.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { addressHmac, enqueueMail, type MailSealing } from './mail-queue.js';
import {
  assertNotLastOwner,
  clearOverrides,
  composeAccess,
  dropOpsAccess,
  isUnenrolledInvitee,
  ignoresAdjustments,
  issueEnrolment,
  lockStaffAdmin,
  looksLikeAuditChange,
  readOverrides,
  readRolePermissions,
  readStaffAccess,
  type StaffAccess,
  withAuditChange,
} from './staff.js';

const MANAGE = 'staff.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN: ReadonlySet<string> = new Set(OPS_PERMISSIONS);

export interface RoleView {
  id: string;
  name: string;
  description: string;
  system: boolean;
  permissions: string[];
  people: number;
}

export interface AccessView {
  roleId: string;
  permissions: string[];
  additions: string[];
  removals: string[];
}

export interface AffectedPerson {
  userId: string;
  email: string | null;
  gains: string[];
  losses: string[];
}

export interface RoleImpact {
  roleId: string;
  added: string[];
  removed: string[];
  affected: AffectedPerson[];
}

const without = (
  from: Iterable<string>,
  remove: { has(value: string): boolean },
): string[] => [...from].filter((value) => !remove.has(value)).sort();

function checkedReason(reason: string): string {
  const trimmed = reason.trim();
  if (
    trimmed.length < 10 ||
    trimmed.length > 500 ||
    looksLikeAuditChange(trimmed)
  )
    throw new OperationError('INVALID_INPUT');
  return trimmed;
}

/** Postgres reads a uuid in any case, so every comparison and record uses this one form. */
const canonicalId = (id: string): string | null =>
  UUID.test(id) ? id.toLowerCase() : null;

function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60)
    throw new OperationError('INVALID_INPUT');
  return trimmed;
}

function checkedDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > 300) throw new OperationError('INVALID_INPUT');
  return trimmed;
}

function checkedPermissions(permissions: readonly string[]): string[] {
  if (permissions.some((permission) => !KNOWN.has(permission)))
    throw new OperationError('INVALID_INPUT');
  return [...new Set(permissions)].sort();
}

function mustHold(held: Set<string>, permissions: Iterable<string>): void {
  for (const permission of permissions)
    if (!held.has(permission)) throw new OperationError('PERMISSION_NOT_HELD');
}

/**
 * Starts a staff-admin change. One lock serialises them all, so every check below sees the result
 * of the change before it: two people can't each pass a check the other is about to invalidate,
 * and an actor who just lost staff.manage can't finish a change already in flight. The actor's
 * access is read here rather than trusted from the route, so an approval run later re-checks it.
 * Nobody acts without a confirmed authenticator on a live account.
 */
async function authorise(
  tx: Tx,
  actorId: string,
): Promise<{ id: string; held: Set<string>; roleId: string }> {
  await lockStaffAdmin(tx);
  const id = canonicalId(actorId);
  const actor = id ? await readStaffAccess(tx, id) : null;
  if (!id || !actor?.permissions.has(MANAGE))
    throw new OperationError('PERMISSION_NOT_HELD');
  // A request that waited on the lock may have lost its authenticator or account meanwhile.
  const [able] = await tx
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
  if (!able) throw new OperationError('PERMISSION_NOT_HELD');
  return { id, held: actor.permissions, roleId: actor.roleId };
}

async function roleOrThrow(tx: Database | Tx, roleId: string) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
  if (!role) throw new OperationError('ROLE_NOT_FOUND');
  return role;
}

async function nameFreeOrThrow(
  tx: Tx,
  name: string,
  exceptRoleId?: string,
): Promise<void> {
  const [clash] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        sql`lower(${roles.name}) = lower(${name})`,
        exceptRoleId ? ne(roles.id, exceptRoleId) : undefined,
      ),
    );
  if (clash) throw new OperationError('ROLE_NAME_TAKEN');
}

async function roleView(tx: Database | Tx, roleId: string): Promise<RoleView> {
  const role = await roleOrThrow(tx, roleId);
  const [count] = await tx
    .select({ people: sql<number>`count(*)::int` })
    .from(staff)
    .where(and(eq(staff.roleId, roleId), isNull(staff.revokedAt)));
  const stored = await readRolePermissions(tx, roleId);
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    system: role.system,
    permissions: (roleId === 'owner' ? [...OPS_PERMISSIONS] : stored).sort(),
    people: count?.people ?? 0,
  };
}

/** Everyone on the role whose effective access would change if it held `next` instead. */
async function impactOf(
  tx: Database | Tx,
  roleId: string,
  next: readonly string[],
): Promise<RoleImpact> {
  const current = await readRolePermissions(tx, roleId);
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  const people = await tx
    .select({ userId: staff.userId, email: users.email })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .where(and(eq(staff.roleId, roleId), isNull(staff.revokedAt)));
  const affected: AffectedPerson[] = [];
  for (const person of people) {
    const overrides = await readOverrides(tx, person.userId);
    const before = composeAccess(roleId, current, overrides).permissions;
    const after = composeAccess(roleId, next, overrides).permissions;
    const gains = without(after, before);
    const losses = without(before, after);
    if (gains.length > 0 || losses.length > 0)
      affected.push({
        userId: person.userId,
        email: person.email,
        gains,
        losses,
      });
  }
  return {
    roleId,
    added: without(nextSet, currentSet),
    removed: without(currentSet, nextSet),
    affected,
  };
}

/** Every role, with how many active people hold it. */
export function listRoles(db: Database): Promise<RoleView[]> {
  return guarded(async () => {
    const rows = await db
      .select({ id: roles.id })
      .from(roles)
      .orderBy(roles.name);
    const views: RoleView[] = [];
    for (const row of rows) views.push(await roleView(db, row.id));
    return views;
  });
}

/** Creates a role holding exactly `permissions`; the actor must hold every one of them. */
export function createRole(
  db: Database,
  input: {
    actorId: string;
    name: string;
    description: string;
    permissions: readonly string[];
    reason: string;
  },
): Promise<RoleView> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const name = checkedName(input.name);
    const description = checkedDescription(input.description);
    const permissions = checkedPermissions(input.permissions);
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      mustHold(actor.held, permissions);
      await nameFreeOrThrow(tx, name);
      const id = newId();
      await tx.insert(roles).values({ id, name, description });
      if (permissions.length > 0)
        await tx
          .insert(rolePermissions)
          .values(
            permissions.map((permission) => ({ roleId: id, permission })),
          );
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'role.created',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: id,
        reason: withAuditChange(reason, { name, permissions }),
      });
      return roleView(tx, id);
    });
  });
}

/** A dry run of a role edit: changes nothing. */
export function roleImpact(
  db: Database,
  input: { roleId: string; permissions: readonly string[] },
): Promise<RoleImpact> {
  return guarded(async () => {
    const permissions = checkedPermissions(input.permissions);
    const role = await roleOrThrow(db, input.roleId);
    if (role.system) throw new OperationError('ROLE_PROTECTED');
    return impactOf(db, input.roleId, permissions);
  });
}

/**
 * Edits a role, which takes effect on the next request for everyone on it. The actor must hold
 * every permission that changes, in either direction, and can't edit the permissions of the role
 * they are on themselves: that would change their own access.
 */
export function updateRole(
  db: Database,
  input: {
    actorId: string;
    roleId: string;
    name?: string;
    description?: string;
    permissions?: readonly string[];
    reason: string;
  },
): Promise<{ role: RoleView; affected: AffectedPerson[] }> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const name = input.name === undefined ? undefined : checkedName(input.name);
    const description =
      input.description === undefined
        ? undefined
        : checkedDescription(input.description);
    const permissions =
      input.permissions === undefined
        ? undefined
        : checkedPermissions(input.permissions);
    if (
      name === undefined &&
      description === undefined &&
      permissions === undefined
    )
      throw new OperationError('INVALID_INPUT');
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const role = await roleOrThrow(tx, input.roleId);
      if (role.system) throw new OperationError('ROLE_PROTECTED');
      let affected: AffectedPerson[] = [];
      let added: string[] = [];
      let removed: string[] = [];
      if (permissions) {
        const impact = await impactOf(tx, input.roleId, permissions);
        const changed = [...impact.added, ...impact.removed];
        if (changed.length > 0 && actor.roleId === input.roleId)
          throw new OperationError('SELF_ACCESS_CHANGE');
        mustHold(actor.held, changed);
        affected = impact.affected;
        added = impact.added;
        removed = impact.removed;
        if (impact.removed.length > 0)
          await tx
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.roleId, input.roleId),
                inArray(rolePermissions.permission, impact.removed),
              ),
            );
        if (impact.added.length > 0)
          await tx.insert(rolePermissions).values(
            impact.added.map((permission) => ({
              roleId: input.roleId,
              permission,
            })),
          );
      }
      if (name !== undefined) await nameFreeOrThrow(tx, name, input.roleId);
      if (name !== undefined || description !== undefined)
        await tx
          .update(roles)
          .set({
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
          })
          .where(eq(roles.id, input.roleId));
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'role.updated',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: input.roleId,
        reason: withAuditChange(reason, {
          added,
          removed,
          ...(name !== undefined && name !== role.name
            ? { name: { from: role.name, to: name } }
            : {}),
          ...(description !== undefined && description !== role.description
            ? { description: { from: role.description, to: description } }
            : {}),
        }),
      });
      return { role: await roleView(tx, input.roleId), affected };
    });
  });
}

/**
 * Deletes a role nobody has held. A removed person's staff row still names their role (it is their
 * history, and role_id is required), so such a role stays and the refusal says why; it can still
 * be renamed or emptied.
 */
export function deleteRole(
  db: Database,
  input: { actorId: string; roleId: string; reason: string },
): Promise<void> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    await db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const role = await roleOrThrow(tx, input.roleId);
      if (role.system) throw new OperationError('ROLE_PROTECTED');
      const permissions = (await readRolePermissions(tx, input.roleId)).sort();
      mustHold(actor.held, permissions);
      const holders = await tx
        .select({ revokedAt: staff.revokedAt })
        .from(staff)
        .where(eq(staff.roleId, input.roleId));
      if (holders.some((holder) => !holder.revokedAt))
        throw new OperationError('ROLE_IN_USE');
      if (holders.length > 0)
        throw new OperationError('ROLE_HAS_FORMER_HOLDERS');
      await tx
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, input.roleId));
      await tx.delete(roles).where(eq(roles.id, input.roleId));
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'role.deleted',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: input.roleId,
        reason: withAuditChange(reason, { name: role.name, permissions }),
      });
    });
  });
}

/** Role, role-plus-adjustments permissions, and the adjustments; null if not active staff. */
export function effectiveAccess(
  db: Database | Tx,
  userId: string,
): Promise<AccessView | null> {
  return guarded(async () => {
    if (!UUID.test(userId)) return null;
    const access = await readStaffAccess(db, userId);
    return access && { ...access, permissions: [...access.permissions].sort() };
  });
}

/** The target, unless they are the actor (nobody changes their own access) or not active staff. */
async function targetOrThrow(
  tx: Tx,
  actorId: string,
  userId: string,
): Promise<{ id: string; access: StaffAccess }> {
  const id = canonicalId(userId);
  if (id === actorId) throw new OperationError('SELF_ACCESS_CHANGE');
  const access = id ? await readStaffAccess(tx, id) : null;
  if (!id || !access) throw new OperationError('STAFF_NOT_FOUND');
  return { id, access };
}

/**
 * Replaces a person's adjustments with these lists. The actor must hold every permission whose
 * adjustment changes: adding, taking away and clearing all change that person's access. An
 * adjustment left as it was needs nothing, so a manager can work on someone who holds more.
 */
export function setPersonalAccess(
  db: Database,
  input: {
    actorId: string;
    userId: string;
    additions: readonly string[];
    removals: readonly string[];
    reason: string;
  },
): Promise<AccessView> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const additions = checkedPermissions(input.additions);
    const removals = checkedPermissions(input.removals);
    if (additions.some((permission) => removals.includes(permission)))
      throw new OperationError('INVALID_INPUT');
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const target = await targetOrThrow(tx, actor.id, input.userId);
      if (ignoresAdjustments(target.access.roleId))
        throw new OperationError('STAFF_PROTECTED');
      const stored = new Map(
        (await readOverrides(tx, target.id)).map((row) => [
          row.permission,
          row.effect,
        ]),
      );
      const wanted = new Map<string, string>([
        ...additions.map((permission) => [permission, 'add'] as const),
        ...removals.map((permission) => [permission, 'remove'] as const),
      ]);
      const cleared = [...stored.keys()].filter((p) => !wanted.has(p));
      const written = [...wanted].filter(([p, e]) => stored.get(p) !== e);
      mustHold(actor.held, [...cleared, ...written.map(([p]) => p)]);
      if (cleared.length > 0)
        await tx
          .delete(staffPermissionOverrides)
          .where(
            and(
              eq(staffPermissionOverrides.userId, target.id),
              inArray(staffPermissionOverrides.permission, cleared),
            ),
          );
      for (const [permission, effect] of written)
        await tx
          .insert(staffPermissionOverrides)
          .values({
            userId: target.id,
            permission,
            effect,
            grantedBy: actor.id,
          })
          .onConflictDoUpdate({
            target: [
              staffPermissionOverrides.userId,
              staffPermissionOverrides.permission,
            ],
            set: { effect, grantedBy: actor.id, createdAt: new Date() },
          });
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.access_changed',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: target.id,
        reason: withAuditChange(reason, {
          added: written
            .filter(([, e]) => e === 'add')
            .map(([p]) => p)
            .sort(),
          removed: written
            .filter(([, e]) => e === 'remove')
            .map(([p]) => p)
            .sort(),
          clearedAdditions: cleared
            .filter((p) => stored.get(p) === 'add')
            .sort(),
          clearedRemovals: cleared
            .filter((p) => stored.get(p) === 'remove')
            .sort(),
        }),
      });
      const after = await readStaffAccess(tx, target.id);
      return {
        ...after!,
        permissions: [...after!.permissions].sort(),
      };
    });
  });
}

/**
 * Moves a person to another role; their adjustments stay, unless the move is onto owner, where
 * they mean nothing and must not return on a later demotion. The actor must hold every permission
 * of the new role and every permission the person would lose. Only an owner changes who is an
 * owner. release_check is the release account's own role, so nobody moves onto or off it here.
 */
export function changeRole(
  db: Database,
  input: { actorId: string; userId: string; roleId: string; reason: string },
): Promise<AccessView> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const { id: userId, access: target } = await targetOrThrow(
        tx,
        actor.id,
        input.userId,
      );
      const role = await roleOrThrow(tx, input.roleId);
      const previous = await roleOrThrow(tx, target.roleId);
      if (input.roleId === 'release_check' || target.roleId === 'release_check')
        throw new OperationError('ROLE_PROTECTED');
      if (target.roleId === 'owner' && input.roleId !== 'owner')
        await assertNotLastOwner(tx, userId);
      if (
        (input.roleId === 'owner' || target.roleId === 'owner') &&
        actor.roleId !== 'owner'
      )
        throw new OperationError('PERMISSION_NOT_HELD');
      const next = await readRolePermissions(tx, input.roleId);
      const after = composeAccess(
        input.roleId,
        next,
        await readOverrides(tx, userId),
      );
      // Every permission of the role, not only the net gain: a personal removal hiding one
      // could be cleared later, and clearing it wouldn't count as handing out the role.
      mustHold(actor.held, input.roleId === 'owner' ? OPS_PERMISSIONS : next);
      const losses = without(target.permissions, after.permissions);
      mustHold(actor.held, losses);
      // Conditional on the role read above: a writer outside the lock must not be overwritten.
      const moved = await tx
        .update(staff)
        .set({ roleId: input.roleId })
        .where(
          and(
            eq(staff.userId, userId),
            eq(staff.roleId, target.roleId),
            isNull(staff.revokedAt),
          ),
        )
        .returning({ userId: staff.userId });
      if (moved.length === 0) throw new OperationError('STAFF_CHANGED');
      const cleared =
        input.roleId === 'owner' ? await clearOverrides(tx, userId) : {};
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.role_changed',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange(reason, {
          from: { id: previous.id, name: previous.name },
          to: { id: role.id, name: role.name },
          gains: without(after.permissions, target.permissions),
          losses,
          ...cleared,
        }),
      });
      return { ...after, permissions: [...after.permissions].sort() };
    });
  });
}

export type InvitationDelivery = 'queued' | 'suppressed';

export interface InvitationState {
  /** The email's state (queued, sent, failed, suppressed, bounced...), or 'none' if never emailed. */
  status: string;
  /** Whether an unused, unexpired link exists; false means it needs sending again. */
  linkOpen: boolean;
}

/** Replaces any open link with a new one and emails it; says if the address is known not to work. */
async function sendEnrolmentLink(
  tx: Tx,
  sealing: MailSealing,
  input: { userId: string; to: string; kind: 'invited' | 'reset'; now: Date },
): Promise<{ enrolmentExpiresAt: string; delivery: InvitationDelivery }> {
  const enrolment = await issueEnrolment(tx, input.userId, input.now);
  await enqueueMail(tx, sealing, {
    type: 'staff_invitation',
    to: input.to,
    userId: input.userId,
    data: { code: enrolment.code, kind: input.kind },
    dedupeKey: `staff_invitation.${newId()}`,
    expiresAt: enrolment.expiresAt,
    now: input.now,
  });
  const [suppressed] = await tx
    .select({ reason: mailSuppressions.reason })
    .from(mailSuppressions)
    .where(eq(mailSuppressions.addressHmac, addressHmac(sealing, input.to)));
  return {
    enrolmentExpiresAt: enrolment.expiresAt.toISOString(),
    delivery: suppressed ? 'suppressed' : 'queued',
  };
}

/** The proven address of a staff member, or a refusal: a link has nowhere else to go. */
async function provenEmailOrThrow(tx: Tx, userId: string): Promise<string> {
  const [account] = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    );
  if (!account?.email) throw new OperationError('STAFF_NO_EMAIL');
  return account.email;
}

async function invitationState(
  db: Database,
  userId: string,
  now: Date,
): Promise<InvitationState> {
  const [mail] = await db
    .select({ status: mailMessages.status })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.userId, userId),
        eq(mailMessages.type, 'staff_invitation'),
      ),
    )
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(1);
  const [link] = await db
    .select({ userId: staffEnrolments.userId })
    .from(staffEnrolments)
    .where(
      and(
        eq(staffEnrolments.userId, userId),
        isNull(staffEnrolments.usedAt),
        gt(staffEnrolments.expiresAt, now),
      ),
    )
    .limit(1);
  return { status: mail?.status ?? 'none', linkOpen: Boolean(link) };
}

export interface StaffPerson {
  userId: string;
  email: string | null;
  roleId: string;
  roleName: string;
  grantedAt: string;
  /** False until their authenticator is confirmed; until then they count for nothing. */
  enrolled: boolean;
  /** How the newest link is doing, while they haven't enrolled; null once they have. */
  invitation: InvitationState | null;
  permissions: string[];
  additions: string[];
  removals: string[];
}

/** Everyone with staff access now, oldest first; removed people are left out. */
export function activeStaffList(db: Database): Promise<StaffPerson[]> {
  return guarded(async () => {
    const rows = await db
      .select({
        userId: staff.userId,
        email: users.email,
        roleId: staff.roleId,
        roleName: roles.name,
        grantedAt: staff.grantedAt,
        confirmedAt: staffTotp.confirmedAt,
      })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .leftJoin(staffTotp, eq(staffTotp.userId, staff.userId))
      .where(isNull(staff.revokedAt))
      .orderBy(staff.grantedAt);
    const people: StaffPerson[] = [];
    const now = new Date();
    for (const { confirmedAt, grantedAt, ...row } of rows) {
      const access = composeAccess(
        row.roleId,
        await readRolePermissions(db, row.roleId),
        await readOverrides(db, row.userId),
      );
      people.push({
        ...row,
        grantedAt: grantedAt.toISOString(),
        enrolled: Boolean(confirmedAt),
        invitation: confirmedAt
          ? null
          : await invitationState(db, row.userId, now),
        permissions: [...access.permissions].sort(),
        additions: access.additions,
        removals: access.removals,
      });
    }
    return people;
  });
}

/**
 * Adds a person by email and emails them a one-time enrolment link. An address proven on an account
 * uses that account; an address only claimed never does, since nobody has shown they own it. One
 * person holds one staff account, so a mailbox matching active staff is refused. One matching only
 * a removed person restores that same account, and only on their exact address. Any recovery
 * waiting on the account is cancelled: a staff member's address doesn't move. The enrolment code
 * goes only into the email, sealed at rest.
 */
export function addStaff(
  db: Database,
  input: {
    actorId: string;
    email: string;
    roleId: string;
    reason: string;
    sealing: MailSealing;
    now?: Date;
  },
): Promise<{
  userId: string;
  roleId: string;
  enrolmentExpiresAt: string;
  delivery: InvitationDelivery;
}> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const email = normaliseEmail(input.email);
    if (!email) throw new OperationError('INVALID_INPUT');
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const role = await roleOrThrow(tx, input.roleId);
      if (role.id === 'release_check')
        throw new OperationError('ROLE_PROTECTED');
      if (role.id === 'owner' && actor.roleId !== 'owner')
        throw new OperationError('PERMISSION_NOT_HELD');
      const permissions =
        role.id === 'owner'
          ? [...OPS_PERMISSIONS]
          : await readRolePermissions(tx, role.id);
      mustHold(actor.held, permissions);
      const mailbox = normaliseStaffEmail(email);
      const everyone = await tx
        .select({
          userId: staff.userId,
          email: users.email,
          verifiedAt: users.emailVerifiedAt,
          revokedAt: staff.revokedAt,
        })
        .from(staff)
        .innerJoin(users, eq(users.id, staff.userId));
      const matches = everyone.filter(
        (person) =>
          person.email && normaliseStaffEmail(person.email) === mailbox,
      );
      const removed = matches.find(
        (person) =>
          person.revokedAt &&
          person.verifiedAt &&
          person.email?.toLowerCase() === email,
      );
      if (
        matches.some((person) => !person.revokedAt) ||
        (matches.length > 0 && !removed)
      )
        throw new OperationError('STAFF_EMAIL_TAKEN');
      const [proven] = removed
        ? [{ id: removed.userId }]
        : await tx
            .select({ id: users.id })
            .from(users)
            .where(verifiedOwner(email));
      // Recovery rows before the account row: the order completing a recovery takes them in.
      let recoveriesCancelled = 0;
      if (proven) {
        const open = (table: typeof emailRecoveries | typeof phoneRecoveries) =>
          and(
            eq(table.userId, proven.id),
            isNull(table.cancelledAt),
            isNull(table.completedAt),
          );
        const emails = await tx
          .update(emailRecoveries)
          .set({ cancelledAt: now })
          .where(open(emailRecoveries))
          .returning({
            id: emailRecoveries.id,
            newEmail: emailRecoveries.newEmail,
            confirmedAt: emailRecoveries.confirmedAt,
          });
        const phones = await tx
          .update(phoneRecoveries)
          .set({ cancelledAt: now })
          .where(open(phoneRecoveries))
          .returning({ id: phoneRecoveries.id });
        recoveriesCancelled = emails.length + phones.length;
        const [held] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, proven.id), verifiedOwner(email)))
          .for('update');
        // A recovery finished while this waited: the address is no longer theirs.
        if (!held) throw new OperationError('STAFF_CHANGED');
        if (recoveriesCancelled > 0)
          await mailRecoveryCancelled(tx, input.sealing, {
            userId: proven.id,
            signInEmail: email,
            newEmail: emails.find((row) => row.confirmedAt)?.newEmail ?? null,
            now,
          });
      }
      const userId = proven?.id ?? newId();
      // Signing in still needs a code sent to the address, as with grant-owner.
      if (!proven)
        await tx
          .insert(users)
          .values({ id: userId, email, emailVerifiedAt: now });
      if (removed)
        await tx
          .update(staff)
          .set({
            roleId: role.id,
            grantedAt: now,
            revokedAt: null,
            enrolledAt: null,
          })
          .where(eq(staff.userId, userId));
      else
        await tx
          .insert(staff)
          .values({ userId, roleId: role.id, grantedAt: now });
      await dropOpsAccess(tx, userId, now);
      // Removal clears these; a row revoked before that rule might still hold some.
      const cleared = removed ? await clearOverrides(tx, userId) : {};
      const link = await sendEnrolmentLink(tx, input.sealing, {
        userId,
        to: email,
        kind: 'invited',
        now,
      });
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.added',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange(reason, {
          role: { id: role.id, name: role.name },
          permissions: permissions.sort(),
          email: maskEmail(email),
          account: proven ? 'existing' : 'new',
          restored: Boolean(removed),
          recoveriesCancelled,
          delivery: link.delivery,
          ...cleared,
        }),
        now,
      });
      return { userId, roleId: role.id, ...link };
    });
  });
}

/**
 * Sends a new invitation to someone who hasn't enrolled, voiding the old link. Whoever could have
 * invited them can: the actor holds their whole access, only an owner does this for an owner, and
 * release_check stays with the server command.
 */
export function resendInvitation(
  db: Database,
  input: {
    actorId: string;
    userId: string;
    reason: string;
    sealing: MailSealing;
    now?: Date;
  },
): Promise<{ enrolmentExpiresAt: string; delivery: InvitationDelivery }> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const { id: userId, access } = await targetOrThrow(
        tx,
        actor.id,
        input.userId,
      );
      if (access.roleId === 'release_check')
        throw new OperationError('ROLE_PROTECTED');
      if (access.roleId === 'owner' && actor.roleId !== 'owner')
        throw new OperationError('PERMISSION_NOT_HELD');
      mustHold(actor.held, access.permissions);
      const [authenticator] = await tx
        .select({ confirmedAt: staffTotp.confirmedAt })
        .from(staffTotp)
        .where(eq(staffTotp.userId, userId));
      // Someone mid-reset has no confirmed authenticator but did enrol: that link is the owner's reset.
      if (
        authenticator?.confirmedAt ||
        !(await isUnenrolledInvitee(tx, userId))
      )
        throw new OperationError('STAFF_ALREADY_ENROLLED');
      const to = await provenEmailOrThrow(tx, userId);
      // Also drops an authenticator started on the old link and never confirmed.
      await dropOpsAccess(tx, userId, now);
      const link = await sendEnrolmentLink(tx, input.sealing, {
        userId,
        to,
        kind: 'invited',
        now,
      });
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.invitation_resent',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange(reason, {
          linkSentTo: maskEmail(to),
          delivery: link.delivery,
        }),
        now,
      });
      return link;
    });
  });
}

/**
 * Removes a person at once: the staff row is revoked (their history stays), admin sessions end, and
 * their authenticator, open enrolment code and adjustments go, so nothing returns if they ever come
 * back. As with a role change, the actor must hold everything the person loses, and only an owner
 * removes an owner. The last-owner rule answers first, whoever asks.
 */
export function removeStaff(
  db: Database,
  input: {
    actorId: string;
    userId: string;
    reason: string;
    /** Absent only where no mail key is at hand: the notice is then skipped. */
    sealing?: MailSealing;
    now?: Date;
  },
): Promise<void> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const now = input.now ?? new Date();
    await db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const { id: userId, access } = await targetOrThrow(
        tx,
        actor.id,
        input.userId,
      );
      if (access.roleId === 'owner') {
        await assertNotLastOwner(tx, userId);
        if (actor.roleId !== 'owner')
          throw new OperationError('PERMISSION_NOT_HELD');
      }
      mustHold(actor.held, access.permissions);
      const role = await roleOrThrow(tx, access.roleId);
      const removed = await tx
        .update(staff)
        .set({ revokedAt: now })
        .where(and(eq(staff.userId, userId), isNull(staff.revokedAt)))
        .returning({ userId: staff.userId });
      if (removed.length === 0) throw new OperationError('STAFF_CHANGED');
      await dropOpsAccess(tx, userId, now);
      const cleared = await clearOverrides(tx, userId);
      if (input.sealing)
        await mailOwner(tx, input.sealing, {
          userId,
          type: 'staff_access_notice',
          data: { change: 'removed' },
          dedupeKey: `staff_access_notice.${userId}.${now.getTime()}`,
          now,
        });
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.removed',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange(reason, {
          role: { id: role.id, name: role.name },
          losses: [...access.permissions].sort(),
          ...cleared,
        }),
        now,
      });
    });
  });
}

/**
 * For a lost phone: removes the authenticator, ends admin sessions and emails a new one-time link.
 * Owners only. Refused for an account with no proven email, which would be left with no way back
 * in; `grant-owner` prints the code for those.
 */
export function resetAuthenticator(
  db: Database,
  input: {
    actorId: string;
    userId: string;
    reason: string;
    sealing: MailSealing;
    now?: Date;
  },
): Promise<{ enrolmentExpiresAt: string; delivery: InvitationDelivery }> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      if (actor.roleId !== 'owner')
        throw new OperationError('PERMISSION_NOT_HELD');
      const { id: userId } = await targetOrThrow(tx, actor.id, input.userId);
      const to = await provenEmailOrThrow(tx, userId);
      const [authenticator] = await tx
        .select({ userId: staffTotp.userId })
        .from(staffTotp)
        .where(eq(staffTotp.userId, userId));
      await dropOpsAccess(tx, userId, now);
      const link = await sendEnrolmentLink(tx, input.sealing, {
        userId,
        to,
        kind: 'reset',
        now,
      });
      await recordAudit(tx, {
        staffUserId: actor.id,
        action: 'staff.authenticator_reset',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: userId,
        reason: withAuditChange(reason, {
          authenticatorRemoved: Boolean(authenticator),
          linkSentTo: maskEmail(to),
          delivery: link.delivery,
        }),
        now,
      });
      return link;
    });
  });
}
