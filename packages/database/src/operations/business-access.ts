import type { ManagerRole } from '@tipme/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  businessLocations,
  businessManagers,
  businessMembers,
  profiles,
} from '../schema.js';
import { OperationError } from './errors.js';

// TipMe for businesses (PR B0): who may act on a business, used by every lane. Each refusal is
// "not found" on the wire (access-control rule 2): another business's id reads like an unknown one.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signed-in user's open manager row for a business. An owner passes every `locationId` of the
 * business; a location manager only their own. `need.owner` refuses location managers. Throws
 * NOT_A_MANAGER (answered as 404 BUSINESS_NOT_FOUND), or OWNER_REQUIRED for a location manager
 * asked to do an owner's job at their own business.
 */
export async function managerOf(
  db: Database | Tx,
  userId: string,
  businessId: string,
  need: { owner?: true; locationId?: string } = {},
): Promise<{
  managerId: string;
  role: ManagerRole;
  locationId: string | null;
}> {
  if (!UUID.test(businessId)) throw new OperationError('NOT_A_MANAGER');
  const [row] = await db
    .select({
      managerId: businessManagers.id,
      role: businessManagers.role,
      locationId: businessManagers.locationId,
    })
    .from(businessManagers)
    .where(
      and(
        eq(businessManagers.businessId, businessId),
        eq(businessManagers.userId, userId),
        isNull(businessManagers.removedAt),
      ),
    );
  if (!row) throw new OperationError('NOT_A_MANAGER');
  const role = row.role as ManagerRole;
  if (need.locationId !== undefined) {
    if (!UUID.test(need.locationId)) throw new OperationError('NOT_A_MANAGER');
    // The location must belong to this business, whoever asks.
    const [location] = await db
      .select({ id: businessLocations.id })
      .from(businessLocations)
      .where(
        and(
          eq(businessLocations.id, need.locationId),
          eq(businessLocations.businessId, businessId),
        ),
      );
    if (!location) throw new OperationError('NOT_A_MANAGER');
    if (role !== 'owner' && row.locationId !== need.locationId)
      throw new OperationError('NOT_A_MANAGER');
  }
  if (need.owner && role !== 'owner')
    throw new OperationError('OWNER_REQUIRED');
  return { managerId: row.managerId, role, locationId: row.locationId };
}

/** The signed-in user's own open membership, through their page. Otherwise NO_MEMBERSHIP (404). */
export async function ownMembership(
  db: Database | Tx,
  userId: string,
  memberId: string,
): Promise<{ memberId: string; locationId: string; profileId: string }> {
  if (!UUID.test(memberId)) throw new OperationError('NO_MEMBERSHIP');
  const [row] = await db
    .select({
      memberId: businessMembers.id,
      locationId: businessMembers.locationId,
      profileId: businessMembers.profileId,
    })
    .from(businessMembers)
    .innerJoin(profiles, eq(profiles.id, businessMembers.profileId))
    .where(
      and(
        eq(businessMembers.id, memberId),
        eq(profiles.userId, userId),
        isNull(businessMembers.leftAt),
      ),
    );
  if (!row) throw new OperationError('NO_MEMBERSHIP');
  return row;
}

/**
 * The membership a tip may be labelled with: active, at an open location of a verified business,
 * and of the page being tipped. Anything else is null, and the tip goes ahead unlabelled: a
 * label never refuses, blocks or redirects a tip (plan, money safety).
 */
export async function tippableMember(
  tx: Database | Tx,
  profileId: string,
  memberId: string | undefined,
  // Kept for the lanes' shared signature: today's rule has no time window.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above
  now: Date = new Date(),
): Promise<{ memberId: string; locationId: string } | null> {
  if (!memberId || !UUID.test(memberId)) return null;
  const [row] = await tx
    .select({
      memberId: businessMembers.id,
      locationId: businessMembers.locationId,
    })
    .from(businessMembers)
    .innerJoin(
      businessLocations,
      eq(businessLocations.id, businessMembers.locationId),
    )
    .innerJoin(businesses, eq(businesses.id, businessLocations.businessId))
    .where(
      and(
        eq(businessMembers.id, memberId),
        eq(businessMembers.profileId, profileId),
        isNull(businessMembers.leftAt),
        isNull(businessLocations.closedAt),
        eq(businesses.status, 'verified'),
      ),
    );
  return row ?? null;
}
