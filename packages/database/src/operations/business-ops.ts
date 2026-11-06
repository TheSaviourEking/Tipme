import type {
  BusinessStatus,
  ManagerRole,
  OpsBusinessContact,
  OpsBusinessDetail,
  OpsBusinessListQuery,
  OpsBusinessRow,
} from '@tipme/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  businessLocations,
  businessManagers,
  businessMembers,
  businessShifts,
  issues,
  notifications,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { resolveIssue } from './issues.js';

// TipMe for businesses, PR B2: what TipMe staff see of a business, and the changes they make to one.
// Contacts are masked (access-control rule 6); the full contact needs `private.view` and a reason.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 100;

/** The last 4 digits of a phone number, never more. */
export const maskPhoneLast4 = (phone: string): string | undefined => {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
};

/** A manager as staff may see them without a reveal: a masked email, or the phone's last 4. */
const userHintOf = (email: string | null, phone: string | null): string => {
  if (email) return maskEmail(email);
  const last4 = phone ? maskPhoneLast4(phone) : undefined;
  return last4 ? `Phone ending ${last4}` : 'No contact on the account';
};

const likeOf = (text: string) =>
  `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const idOf = (businessId: string) => {
  if (!UUID.test(businessId)) throw new OperationError('BUSINESS_NOT_FOUND');
  return businessId;
};

type RowSql = {
  id: string;
  slug: string;
  name: string;
  status: BusinessStatus;
  created_at: Date | string;
  contact_email: string;
  contact_phone: string | null;
  verified_at: Date | string | null;
  suspended_reason: string | null;
  locations: number;
  members: number;
};

const iso = (value: Date | string) => new Date(value).toISOString();

function rowOf(row: RowSql): OpsBusinessRow {
  const last4 = row.contact_phone
    ? maskPhoneLast4(row.contact_phone)
    : undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: iso(row.created_at),
    contactEmailMasked: maskEmail(row.contact_email),
    ...(last4 ? { contactPhoneLast4: last4 } : {}),
    locations: Number(row.locations),
    members: Number(row.members),
  };
}

const rowsSql = (where: ReturnType<typeof sql>) => sql`
  SELECT b.id, b.slug, b.name, b.status, b.created_at, b.contact_email, b.contact_phone,
         b.verified_at, b.suspended_reason,
         (SELECT count(*)::int FROM business_locations l WHERE l.business_id = b.id) AS locations,
         (SELECT count(*)::int FROM business_members m
            JOIN business_locations l ON l.id = m.location_id
           WHERE l.business_id = b.id AND m.left_at IS NULL) AS members
    FROM businesses b
   WHERE ${where}`;

/** Newest first. `q` matches the name or slug only (never a contact detail). */
export function listOpsBusinesses(
  db: Database,
  query: OpsBusinessListQuery,
): Promise<OpsBusinessRow[]> {
  return guarded(async () => {
    const conditions = [sql`TRUE`];
    if (query.status) conditions.push(sql`b.status = ${query.status}`);
    if (query.q) {
      const like = likeOf(query.q.toLowerCase());
      conditions.push(sql`(lower(b.name) LIKE ${like} OR b.slug LIKE ${like})`);
    }
    const result = await db.execute<RowSql>(sql`
      ${rowsSql(sql.join(conditions, sql` AND `))}
      ORDER BY b.created_at DESC, b.id
      LIMIT ${LIST_LIMIT}`);
    return result.rows.map(rowOf);
  });
}

/** One business, masked. Throws BUSINESS_NOT_FOUND. */
export function opsBusinessDetail(
  db: Database | Tx,
  businessId: string,
): Promise<OpsBusinessDetail> {
  return guarded(async () => {
    const id = idOf(businessId);
    const result = await db.execute<RowSql>(rowsSql(sql`b.id = ${id}`));
    const row = result.rows[0];
    if (!row) throw new OperationError('BUSINESS_NOT_FOUND');
    const locationList = await db
      .select({
        id: businessLocations.id,
        slug: businessLocations.slug,
        name: businessLocations.name,
        address: businessLocations.address,
        closedAt: businessLocations.closedAt,
      })
      .from(businessLocations)
      .where(eq(businessLocations.businessId, id))
      .orderBy(asc(businessLocations.createdAt), asc(businessLocations.slug));
    const managers = await openManagers(db, id);
    return {
      ...rowOf(row),
      locationList: locationList.map(({ closedAt, ...location }) => ({
        ...location,
        closed: closedAt !== null,
      })),
      managers: managers.map((manager) => ({
        userHint: userHintOf(manager.email, manager.phone),
        role: manager.role,
      })),
      ...(row.verified_at ? { verifiedAt: iso(row.verified_at) } : {}),
      ...(row.suspended_reason
        ? { suspendedReason: row.suspended_reason }
        : {}),
    };
  });
}

async function openManagers(db: Database | Tx, businessId: string) {
  const rows = await db
    .select({
      role: businessManagers.role,
      email: users.email,
      phone: users.phoneE164,
    })
    .from(businessManagers)
    .innerJoin(users, eq(users.id, businessManagers.userId))
    .where(
      and(
        eq(businessManagers.businessId, businessId),
        isNull(businessManagers.removedAt),
      ),
    )
    // Owners first, then by when they were added.
    .orderBy(asc(businessManagers.role), asc(businessManagers.createdAt));
  return rows.map((row) => ({ ...row, role: row.role as ManagerRole }));
}

/** The full contact and the managers' emails. Audited with the reason, in the same transaction. */
export function revealBusinessContact(
  db: Database,
  input: { staffUserId: string; businessId: string; reason: string },
): Promise<OpsBusinessContact> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const id = idOf(input.businessId);
      const [business] = await tx
        .select({
          contactName: businesses.contactName,
          contactEmail: businesses.contactEmail,
          contactPhone: businesses.contactPhone,
        })
        .from(businesses)
        .where(eq(businesses.id, id));
      if (!business) throw new OperationError('BUSINESS_NOT_FOUND');
      const managers = await openManagers(tx, id);
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'business.reveal',
        permission: 'private.view',
        subjectType: 'business',
        subjectId: id,
        reason: input.reason,
      });
      return {
        contactName: business.contactName,
        contactEmail: business.contactEmail,
        ...(business.contactPhone
          ? { contactPhone: business.contactPhone }
          : {}),
        managers: managers.map(({ email, role }) => ({
          ...(email ? { email } : {}),
          role,
        })),
      };
    }),
  );
}

async function lockBusiness(tx: Tx, businessId: string) {
  const [business] = await tx
    .select({
      slug: businesses.slug,
      name: businesses.name,
      status: businesses.status,
    })
    .from(businesses)
    .where(eq(businesses.id, idOf(businessId)))
    .for('update');
  if (!business) throw new OperationError('BUSINESS_NOT_FOUND');
  return { ...business, status: business.status as BusinessStatus };
}

/**
 * Pauses a verified business: its public pages stop at once (M11) and so does attribution, which
 * reads the status. Every open shift ends with `ended_by 'expired'`: the system ended it, not a
 * manager, and nobody at the business chose to. Suspending a suspended business changes nothing.
 */
export function suspendBusiness(
  db: Database,
  input: {
    staffUserId: string;
    businessId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ slug: string; changed: boolean }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      const business = await lockBusiness(tx, input.businessId);
      if (business.status === 'suspended')
        return { slug: business.slug, changed: false };
      // A waiting business has no pages to stop; the database refuses it too.
      if (business.status !== 'verified')
        throw new OperationError('BUSINESS_NOT_VERIFIED');
      await tx
        .update(businesses)
        .set({
          status: 'suspended',
          suspendedAt: now,
          suspendedReason: input.reason,
        })
        .where(eq(businesses.id, input.businessId));
      const members = tx
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .innerJoin(
          businessLocations,
          eq(businessLocations.id, businessMembers.locationId),
        )
        .where(eq(businessLocations.businessId, input.businessId));
      await tx
        .update(businessShifts)
        .set({ endedAt: now, endedBy: 'expired' })
        .where(
          and(
            isNull(businessShifts.endedAt),
            inArray(businessShifts.memberId, members),
          ),
        );
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'business.suspended',
        permission: 'businesses.manage',
        subjectType: 'business',
        subjectId: input.businessId,
        reason: input.reason,
        now,
      });
      return { slug: business.slug, changed: true };
    }),
  );
}

/** Lifts a suspension: the business is verified again. Shifts stay ended; people check in again. */
export function restoreBusiness(
  db: Database,
  input: {
    staffUserId: string;
    businessId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ slug: string; changed: boolean }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const business = await lockBusiness(tx, input.businessId);
      if (business.status === 'verified')
        return { slug: business.slug, changed: false };
      if (business.status !== 'suspended')
        throw new OperationError('BUSINESS_NOT_VERIFIED');
      await tx
        .update(businesses)
        .set({ status: 'verified', suspendedAt: null, suspendedReason: null })
        .where(eq(businesses.id, input.businessId));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'business.restored',
        permission: 'businesses.manage',
        subjectType: 'business',
        subjectId: input.businessId,
        reason: input.reason,
        ...(input.now ? { now: input.now } : {}),
      });
      return { slug: business.slug, changed: true };
    }),
  );
}

/**
 * The business's open managers by user id (owners only when asked): everyone a verification
 * concerns, so none of them can decide it, and the owners who are told about it.
 */
export async function businessManagerUsers(
  db: Database | Tx,
  businessId: string,
  only: { owners?: true } = {},
): Promise<string[]> {
  if (!UUID.test(businessId)) return [];
  const rows = await db
    .select({ userId: businessManagers.userId })
    .from(businessManagers)
    .where(
      and(
        eq(businessManagers.businessId, businessId),
        isNull(businessManagers.removedAt),
        ...(only.owners ? [eq(businessManagers.role, 'owner')] : []),
      ),
    );
  return rows.map((row) => row.userId);
}

/** What `business.verify` pins: if either moves before approval, the request goes stale. */
export async function businessVerifyFacts(
  db: Database | Tx,
  businessId: string,
): Promise<{ status: string; slug: string } | null> {
  if (!UUID.test(businessId)) return null;
  const [row] = await db
    .select({ status: businesses.status, slug: businesses.slug })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  return row ?? null;
}

/**
 * The serious action's work (`business.verify`), in the caller's transaction: a waiting business
 * becomes verified, its `business_waiting` issue is resolved and each owner gets an in-app notice.
 * Anything else is INVALID_INPUT, so a dry run at asking refuses it.
 */
export async function verifyBusiness(
  tx: Tx,
  input: {
    businessId: string;
    staffUserId: string;
    reason: string;
    now: Date;
  },
): Promise<{ slug: string; name: string }> {
  const business = await lockBusiness(tx, input.businessId);
  if (business.status !== 'pending') throw new OperationError('INVALID_INPUT');
  await tx
    .update(businesses)
    .set({
      status: 'verified',
      verifiedAt: input.now,
      verifiedBy: input.staffUserId,
    })
    .where(eq(businesses.id, input.businessId));
  const waiting = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.kind, 'business_waiting'),
        eq(issues.status, 'open'),
        sql`${issues.subject}->>'businessId' = ${input.businessId}`,
      ),
    );
  for (const issue of waiting)
    await resolveIssue(tx, {
      issueId: issue.id,
      staffUserId: input.staffUserId,
      reason: input.reason,
      now: input.now,
    });
  for (const userId of await businessManagerUsers(tx, input.businessId, {
    owners: true,
  }))
    await tx.insert(notifications).values({
      id: newId(),
      userId,
      kind: 'business_verified',
      businessId: input.businessId,
      title: `${business.name} is verified`,
      body: 'Your codes are ready to print.',
      createdAt: input.now,
    });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'business.verified',
    permission: 'businesses.manage',
    subjectType: 'business',
    subjectId: input.businessId,
    reason: input.reason,
    now: input.now,
  });
  return { slug: business.slug, name: business.name };
}
