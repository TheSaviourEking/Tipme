import type {
  BusinessApplication,
  BusinessDetail,
  BusinessStatus,
  BusinessUpdate,
  LocationInput,
  LocationUpdate,
  ManagerRole,
  ManagerRow,
} from '@tipme/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  businessLocations,
  businessManagers,
  businessMembers,
  businessShifts,
  profiles,
  users,
} from '../schema.js';
import { managerOf } from './business-access.js';
import { assertCanAddLocation } from './business-limits.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';

// TipMe for businesses, PR B1: applying for a business, editing it, its locations and its managers.
// Every write asks managerOf first, so another business's id reads like an unknown one (rule 2).
// Slugs lock once TipMe has verified the business (M7): printed codes are never reprinted.

/**
 * Anyone signed in with a proven email may apply (owner's answer Q3). One transaction makes the
 * pending business, its first location, the applicant as its owner, and the business_waiting
 * issue that asks TipMe staff to check it. Nothing goes live until staff verify it (PR B2).
 */
export function applyForBusiness(
  db: Database,
  userId: string,
  input: BusinessApplication,
  now: Date = new Date(),
): Promise<BusinessDetail> {
  return guarded(async () => {
    const [account] = await db
      .select({ verified: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!account?.verified)
      throw new OperationError('EMAIL_VERIFICATION_REQUIRED');
    const businessId = newId();
    await db.transaction(async (tx) => {
      // On a taken slug nothing is written: the conflict is skipped, not raised, so the
      // transaction stays usable and the answer is the field-level BUSINESS_SLUG_TAKEN.
      const inserted = await tx
        .insert(businesses)
        .values({
          id: businessId,
          slug: input.slug,
          name: input.name,
          status: 'pending',
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone ?? null,
          createdBy: userId,
          createdAt: now,
        })
        .onConflictDoNothing({ target: businesses.slug })
        .returning({ id: businesses.id });
      if (!inserted[0]) throw new OperationError('BUSINESS_SLUG_TAKEN');
      await tx.insert(businessLocations).values({
        id: newId(),
        businessId,
        slug: input.location.slug,
        name: input.location.name,
        address: input.location.address,
        createdAt: now,
      });
      await tx.insert(businessManagers).values({
        id: newId(),
        businessId,
        userId,
        role: 'owner',
        addedBy: userId,
        createdAt: now,
      });
      // Ids only (issues carry no names or contacts). The applicant is the subject's person, so
      // a staff member who applied can't be the one to close it.
      await openIssue(tx, {
        dedupeKey: `business_waiting:${businessId}`,
        kind: 'business_waiting',
        subject: { businessId, userId },
        now,
      });
    });
    return readDetail(db, userId, businessId);
  });
}

/** The business as a manager sees it. A location manager sees only their location. */
export function businessDetail(
  db: Database,
  userId: string,
  businessId: string,
): Promise<BusinessDetail> {
  return guarded(() => readDetail(db, userId, businessId));
}

/**
 * Owners only. The slug and the name change only while pending (SLUG_LOCKED,
 * BUSINESS_NAME_LOCKED once verified).
 */
export function updateBusiness(
  db: Database,
  userId: string,
  businessId: string,
  patch: BusinessUpdate,
): Promise<BusinessDetail> {
  return guarded(async () => {
    await db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { owner: true });
      const current = await lockBusiness(tx, businessId);
      const changes: Partial<typeof businesses.$inferInsert> = {};
      if (patch.slug !== undefined && patch.slug !== current.slug) {
        if (current.status !== 'pending')
          throw new OperationError('SLUG_LOCKED');
        const [taken] = await tx
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.slug, patch.slug));
        if (taken) throw new OperationError('BUSINESS_SLUG_TAKEN');
        changes.slug = patch.slug;
      }
      // The name TipMe checked is locked once verified (coordinator ruling, 6 Nov 2026): the
      // verified badge never shows a name TipMe didn't check. Staff renames come later.
      if (patch.name !== undefined && patch.name !== current.name) {
        if (current.status !== 'pending')
          throw new OperationError('BUSINESS_NAME_LOCKED');
        changes.name = patch.name;
      }
      if (patch.contactName !== undefined)
        changes.contactName = patch.contactName;
      if (patch.contactEmail !== undefined)
        changes.contactEmail = patch.contactEmail;
      if (patch.contactPhone !== undefined)
        changes.contactPhone = patch.contactPhone;
      if (Object.keys(changes).length === 0) return;
      await tx
        .update(businesses)
        .set(changes)
        .where(eq(businesses.id, businessId))
        .catch(slugRace('BUSINESS_SLUG_TAKEN'));
    });
    return readDetail(db, userId, businessId);
  });
}

/** Owners only. Its slug is chosen now and, once the business is verified, kept. */
export function addLocation(
  db: Database,
  userId: string,
  businessId: string,
  input: LocationInput,
  now: Date = new Date(),
  /** Business Pro (plan Task A4): the API passes BUSINESS_PRO_ENABLED. */
  opts: { enforceLimits?: boolean } = {},
): Promise<BusinessDetail> {
  return guarded(async () => {
    await db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { owner: true });
      if (opts.enforceLimits) await assertCanAddLocation(tx, businessId);
      const inserted = await tx
        .insert(businessLocations)
        .values({
          id: newId(),
          businessId,
          slug: input.slug,
          name: input.name,
          address: input.address,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [businessLocations.businessId, businessLocations.slug],
        })
        .returning({ id: businessLocations.id });
      if (!inserted[0]) throw new OperationError('LOCATION_SLUG_TAKEN');
    });
    return readDetail(db, userId, businessId);
  });
}

/** An owner, or that location's own manager. The slug is locked once the business is verified. */
export function updateLocation(
  db: Database,
  userId: string,
  businessId: string,
  locationId: string,
  patch: LocationUpdate,
): Promise<BusinessDetail> {
  return guarded(async () => {
    await db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { locationId });
      const business = await lockBusiness(tx, businessId);
      const [location] = await tx
        .select({ slug: businessLocations.slug })
        .from(businessLocations)
        .where(eq(businessLocations.id, locationId));
      if (!location) throw new OperationError('NOT_A_MANAGER');
      const changes: Partial<typeof businessLocations.$inferInsert> = {};
      if (patch.slug !== undefined && patch.slug !== location.slug) {
        if (business.status !== 'pending')
          throw new OperationError('SLUG_LOCKED');
        const [taken] = await tx
          .select({ id: businessLocations.id })
          .from(businessLocations)
          .where(
            and(
              eq(businessLocations.businessId, businessId),
              eq(businessLocations.slug, patch.slug),
            ),
          );
        if (taken) throw new OperationError('LOCATION_SLUG_TAKEN');
        changes.slug = patch.slug;
      }
      if (patch.name !== undefined) changes.name = patch.name;
      if (patch.address !== undefined) changes.address = patch.address;
      if (Object.keys(changes).length === 0) return;
      await tx
        .update(businessLocations)
        .set(changes)
        .where(eq(businessLocations.id, locationId))
        .catch(slugRace('LOCATION_SLUG_TAKEN'));
    });
    return readDetail(db, userId, businessId);
  });
}

/**
 * Owners only. The location page stops showing and takes no labelled tip (tippableMember reads
 * closed_at); open shifts there end now. Memberships stay: the people are still on the team.
 */
export function closeLocation(
  db: Database,
  userId: string,
  businessId: string,
  locationId: string,
  now: Date = new Date(),
): Promise<BusinessDetail> {
  return guarded(async () => {
    await db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { owner: true, locationId });
      const closed = await tx
        .update(businessLocations)
        .set({ closedAt: now })
        .where(
          and(
            eq(businessLocations.id, locationId),
            isNull(businessLocations.closedAt),
          ),
        )
        .returning({ id: businessLocations.id });
      if (!closed[0]) return;
      const here = tx
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(eq(businessMembers.locationId, locationId));
      await tx
        .update(businessShifts)
        .set({ endedAt: now, endedBy: 'manager' })
        .where(
          and(
            isNull(businessShifts.endedAt),
            inArray(businessShifts.memberId, here),
          ),
        );
    });
    return readDetail(db, userId, businessId);
  });
}

/** Any manager of the business. Owners first, then by when they were added. */
export function listManagers(
  db: Database,
  userId: string,
  businessId: string,
): Promise<ManagerRow[]> {
  return guarded(async () => {
    await managerOf(db, userId, businessId);
    const rows = await db
      .select({
        managerId: businessManagers.id,
        role: businessManagers.role,
        locationId: businessManagers.locationId,
        userId: businessManagers.userId,
        displayName: profiles.displayName,
        handle: profiles.handle,
      })
      .from(businessManagers)
      .leftJoin(profiles, eq(profiles.userId, businessManagers.userId))
      .where(
        and(
          eq(businessManagers.businessId, businessId),
          isNull(businessManagers.removedAt),
        ),
      )
      .orderBy(
        sql`${businessManagers.role} <> 'owner'`,
        asc(businessManagers.createdAt),
        asc(businessManagers.id),
      );
    return rows.map((row) => ({
      managerId: row.managerId,
      role: row.role as ManagerRole,
      ...(row.locationId ? { locationId: row.locationId } : {}),
      // Never a phone or an email: the name their own page shows, else plain words.
      name: row.displayName || (row.handle ? `@${row.handle}` : 'A TipMe user'),
      you: row.userId === userId,
    }));
  });
}

/**
 * Owners only. Refuses removing the last owner (BUSINESS_LAST_OWNER). The business row is locked
 * first, so two owners removing each other at the same moment leave one.
 */
export function removeManager(
  db: Database,
  userId: string,
  businessId: string,
  managerId: string,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { owner: true });
      await lockBusiness(tx, businessId);
      // Read again under the lock: an owner removing this person at the same moment has won.
      await managerOf(tx, userId, businessId, { owner: true });
      if (!UUID.test(managerId)) throw new OperationError('NOT_A_MANAGER');
      const [target] = await tx
        .select({ role: businessManagers.role })
        .from(businessManagers)
        .where(
          and(
            eq(businessManagers.id, managerId),
            eq(businessManagers.businessId, businessId),
            isNull(businessManagers.removedAt),
          ),
        );
      if (!target) throw new OperationError('NOT_A_MANAGER');
      if (target.role === 'owner') {
        const [owners] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(businessManagers)
          .where(
            and(
              eq(businessManagers.businessId, businessId),
              eq(businessManagers.role, 'owner'),
              isNull(businessManagers.removedAt),
            ),
          );
        if ((owners?.n ?? 0) <= 1)
          throw new OperationError('BUSINESS_LAST_OWNER');
      }
      await tx
        .update(businessManagers)
        .set({ removedAt: now })
        .where(eq(businessManagers.id, managerId));
    }),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A concurrent writer took the slug between the check and the update. */
const slugRace =
  (code: 'BUSINESS_SLUG_TAKEN' | 'LOCATION_SLUG_TAKEN') =>
  (error: unknown): never => {
    if (sqlStateOf(error) === '23505') throw new OperationError(code);
    throw error;
  };

async function lockBusiness(
  tx: Tx,
  businessId: string,
): Promise<{ slug: string; name: string; status: string }> {
  const [row] = await tx
    .select({
      slug: businesses.slug,
      name: businesses.name,
      status: businesses.status,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .for('update');
  if (!row) throw new OperationError('NOT_A_MANAGER');
  return row;
}

async function readDetail(
  db: Database | Tx,
  userId: string,
  businessId: string,
): Promise<BusinessDetail> {
  const you = await managerOf(db, userId, businessId);
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!business) throw new OperationError('NOT_A_MANAGER');
  const locations = await db
    .select({
      id: businessLocations.id,
      slug: businessLocations.slug,
      name: businessLocations.name,
      address: businessLocations.address,
      closedAt: businessLocations.closedAt,
    })
    .from(businessLocations)
    .where(
      and(
        eq(businessLocations.businessId, businessId),
        you.role === 'owner'
          ? undefined
          : you.locationId
            ? eq(businessLocations.id, you.locationId)
            : sql`false`,
      ),
    )
    .orderBy(asc(businessLocations.createdAt), asc(businessLocations.id));
  const status = business.status as BusinessStatus;
  return {
    id: business.id,
    slug: business.slug,
    name: business.name,
    status,
    ...(status === 'suspended' && business.suspendedReason
      ? { suspendedReason: business.suspendedReason }
      : {}),
    slugLocked: status !== 'pending',
    ...(business.logoPath ? { logoPath: business.logoPath } : {}),
    contact: {
      name: business.contactName,
      email: business.contactEmail,
      ...(business.contactPhone ? { phone: business.contactPhone } : {}),
    },
    locations: locations.map((location) => ({
      id: location.id,
      slug: location.slug,
      name: location.name,
      address: location.address,
      closed: location.closedAt !== null,
    })),
    you: {
      role: you.role,
      ...(you.locationId ? { locationId: you.locationId } : {}),
    },
  };
}
