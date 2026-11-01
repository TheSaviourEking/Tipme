import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  OPS_PERMISSIONS,
  rolePermissions,
  roles,
  staff,
  staffPermissionOverrides,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import {
  composeAccess,
  ignoresAdjustments,
  readOverrides,
  readRolePermissions,
  readStaffAccess,
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
  if (trimmed.length < 10 || trimmed.length > 500)
    throw new OperationError('INVALID_INPUT');
  return trimmed;
}

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
 */
async function authorise(
  tx: Tx,
  actorId: string,
): Promise<{ held: Set<string>; roleId: string }> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
  );
  const actor = UUID.test(actorId) ? await readStaffAccess(tx, actorId) : null;
  if (!actor?.permissions.has(MANAGE))
    throw new OperationError('PERMISSION_NOT_HELD');
  return { held: actor.permissions, roleId: actor.roleId };
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
        staffUserId: input.actorId,
        action: 'role.created',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: id,
        reason,
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
      if (permissions) {
        const impact = await impactOf(tx, input.roleId, permissions);
        const changed = [...impact.added, ...impact.removed];
        if (changed.length > 0 && actor.roleId === input.roleId)
          throw new OperationError('SELF_ACCESS_CHANGE');
        mustHold(actor.held, changed);
        affected = impact.affected;
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
        staffUserId: input.actorId,
        action: 'role.updated',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: input.roleId,
        reason,
      });
      return { role: await roleView(tx, input.roleId), affected };
    });
  });
}

/**
 * Deletes a role nobody is on. A revoked staff row still names its role (the person's history
 * stays), so a role that anyone has ever held and been removed from also counts as in use.
 */
export function deleteRole(
  db: Database,
  input: { actorId: string; roleId: string; reason: string },
): Promise<void> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    await db.transaction(async (tx) => {
      await authorise(tx, input.actorId);
      const role = await roleOrThrow(tx, input.roleId);
      if (role.system) throw new OperationError('ROLE_PROTECTED');
      const [holder] = await tx
        .select({ userId: staff.userId })
        .from(staff)
        .where(eq(staff.roleId, input.roleId))
        .limit(1);
      if (holder) throw new OperationError('ROLE_IN_USE');
      await tx
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, input.roleId));
      await tx.delete(roles).where(eq(roles.id, input.roleId));
      await recordAudit(tx, {
        staffUserId: input.actorId,
        action: 'role.deleted',
        permission: MANAGE,
        subjectType: 'role',
        subjectId: input.roleId,
        reason,
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
): Promise<NonNullable<Awaited<ReturnType<typeof readStaffAccess>>>> {
  if (userId === actorId) throw new OperationError('SELF_ACCESS_CHANGE');
  const target = UUID.test(userId) ? await readStaffAccess(tx, userId) : null;
  if (!target) throw new OperationError('STAFF_NOT_FOUND');
  return target;
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
      const target = await targetOrThrow(tx, input.actorId, input.userId);
      if (ignoresAdjustments(target.roleId))
        throw new OperationError('STAFF_PROTECTED');
      const stored = new Map(
        (await readOverrides(tx, input.userId)).map((row) => [
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
              eq(staffPermissionOverrides.userId, input.userId),
              inArray(staffPermissionOverrides.permission, cleared),
            ),
          );
      for (const [permission, effect] of written)
        await tx
          .insert(staffPermissionOverrides)
          .values({
            userId: input.userId,
            permission,
            effect,
            grantedBy: input.actorId,
          })
          .onConflictDoUpdate({
            target: [
              staffPermissionOverrides.userId,
              staffPermissionOverrides.permission,
            ],
            set: { effect, grantedBy: input.actorId, createdAt: new Date() },
          });
      await recordAudit(tx, {
        staffUserId: input.actorId,
        action: 'staff.access_changed',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: input.userId,
        reason,
      });
      const after = await readStaffAccess(tx, input.userId);
      return {
        ...after!,
        permissions: [...after!.permissions].sort(),
      };
    });
  });
}

/**
 * Moves a person to another role; their adjustments stay. The actor must hold every permission of
 * the new role and every permission the person would lose. Only an owner changes who is an owner.
 * release_check is the release account's own role, so nobody moves onto or off it from here.
 *
 * Because nobody can change their own role, an owner being demoted always leaves the owner acting,
 * so this path can't remove the last owner.
 */
export function changeRole(
  db: Database,
  input: { actorId: string; userId: string; roleId: string; reason: string },
): Promise<AccessView> {
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      const actor = await authorise(tx, input.actorId);
      const target = await targetOrThrow(tx, input.actorId, input.userId);
      await roleOrThrow(tx, input.roleId);
      if (input.roleId === 'release_check' || target.roleId === 'release_check')
        throw new OperationError('ROLE_PROTECTED');
      if (
        (input.roleId === 'owner' || target.roleId === 'owner') &&
        actor.roleId !== 'owner'
      )
        throw new OperationError('PERMISSION_NOT_HELD');
      const next = await readRolePermissions(tx, input.roleId);
      const after = composeAccess(
        input.roleId,
        next,
        await readOverrides(tx, input.userId),
      );
      // Every permission of the role, not only the net gain: a personal removal hiding one
      // could be cleared later, and clearing it wouldn't count as handing out the role.
      mustHold(actor.held, input.roleId === 'owner' ? OPS_PERMISSIONS : next);
      mustHold(actor.held, without(target.permissions, after.permissions));
      await tx
        .update(staff)
        .set({ roleId: input.roleId })
        .where(eq(staff.userId, input.userId));
      await recordAudit(tx, {
        staffUserId: input.actorId,
        action: 'staff.role_changed',
        permission: MANAGE,
        subjectType: 'user',
        subjectId: input.userId,
        reason,
      });
      return { ...after, permissions: [...after.permissions].sort() };
    });
  });
}
