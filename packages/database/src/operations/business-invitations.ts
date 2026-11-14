import { createHash, randomBytes } from 'node:crypto';
import {
  type InvitationAccepted,
  type InvitationAnswer,
  type InvitationCreated,
  type InvitationKind,
  type InvitationPreview,
  type InvitationRequest,
  type InvitationRow,
  type InvitationState,
  type InvitationTarget,
  type InviteeCard,
  type ManagerRole,
  type MyInvitations,
} from '@tipme/contracts';
import { firstNameOf, INVITATION_DAYS } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { managerOf } from './business-access.js';
import { myMembership } from './business-members.js';
import { assertCanAddStaff } from './business-limits.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

// TipMe for businesses, PR B3: inviting people to a team or to help manage a business, by email,
// by a one-time link, or by a TipMe username (owner's answer, 6 Nov 2026). A business never makes
// an account: whoever accepts uses their own. Only a code's sha256 is kept; every bad answer
// (unknown, used, expired, revoked, declined, or addressed to someone else) is INVITATION_INVALID.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** 16 characters of base32: 80 random bits (256 is a multiple of 32, so each is uniform). */
const newCode = () =>
  Array.from(randomBytes(16), (byte) => BASE32[byte & 31]).join('');
/** Where the code is used: only ever in the fragment, which no server or log sees. */
export const joinLink = (code: string) => `/dashboard/work#join=${code}`;

/** A live, active, public page that is not a release-check rehearsal, of an account not deleted. */
const INVITABLE_PAGE = sql`p.page_state = 'live' AND p.status = 'active' AND p.visibility = 'public'
  AND p.rehearsal_run_id IS NULL AND u.deleted_at IS NULL`;

function stateOf(
  row: {
    accepted_at: unknown;
    declined_at: unknown;
    revoked_at: unknown;
    expires_at: Date | string;
  },
  now: Date,
): InvitationState {
  if (row.accepted_at) return 'accepted';
  if (row.declined_at) return 'declined';
  if (row.revoked_at) return 'revoked';
  return new Date(row.expires_at).getTime() <= now.getTime()
    ? 'expired'
    : 'open';
}

/**
 * A manager invites someone. Staff join one location (its manager or an owner may invite); only
 * owners invite managers. An email goes to an email invitation's address and, for a username, to
 * the account's confirmed address; an account that can answer also gets an in-app notification.
 * Someone who blocked the business gets neither: by username that is refused, by email it is
 * silent, so an address never tells the business whether it belongs to a TipMe account.
 */
export function inviteToBusiness(
  db: Database,
  sealing: MailSealing,
  userId: string,
  businessId: string,
  input: InvitationRequest,
  now: Date = new Date(),
  /** Business Pro (plan Task A4): the API passes BUSINESS_PRO_ENABLED. */
  opts: { enforceLimits?: boolean } = {},
): Promise<InvitationCreated> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const locationId = 'locationId' in input ? input.locationId : undefined;
      await managerOf(tx, userId, businessId, {
        ...(input.kind === 'manager' ? { owner: true as const } : {}),
        ...(locationId ? { locationId } : {}),
      });
      const role: ManagerRole | null =
        input.kind === 'manager' ? input.role : null;
      const place = await tx.execute<{
        name: string;
        status: string;
        location_name: string | null;
        location_closed: boolean | null;
      }>(sql`
        SELECT b.name, b.status, l.name AS location_name, l.closed_at IS NOT NULL AS location_closed
          FROM businesses b
          LEFT JOIN business_locations l ON l.id = ${locationId ?? null}::uuid
         WHERE b.id = ${businessId}
           FOR UPDATE OF b`);
      const business = place.rows[0];
      if (!business || business.location_closed)
        throw new OperationError('NOT_A_MANAGER');
      // A business TipMe paused invites nobody until it is restored.
      if (business.status === 'suspended')
        throw new OperationError('BUSINESS_NOT_VERIFIED');

      const target = input.target;
      let invitee: {
        profileId: string | null;
        userId: string;
        email: string | null;
      } | null = null;
      let emailLower: string | null = null;
      let silent = false;
      if (target.kind === 'user') {
        const found = await tx.execute<{
          profile_id: string;
          user_id: string;
          email: string | null;
          email_verified_at: unknown;
        }>(sql`
          SELECT p.id AS profile_id, u.id AS user_id, u.email, u.email_verified_at
            FROM profiles p JOIN users u ON u.id = p.user_id
           WHERE p.handle_lower = ${target.handle} AND ${INVITABLE_PAGE}`);
        const row = found.rows[0];
        if (!row) throw new OperationError('INVITEE_UNAVAILABLE');
        invitee = {
          profileId: row.profile_id,
          userId: row.user_id,
          email: row.email_verified_at ? row.email : null,
        };
        if (await isBlocked(tx, businessId, row.user_id))
          throw new OperationError('INVITATIONS_BLOCKED');
        const already =
          input.kind === 'staff'
            ? await tx.execute(sql`
                SELECT 1 FROM business_members
                 WHERE location_id = ${locationId ?? null}::uuid AND profile_id = ${row.profile_id}
                   AND left_at IS NULL`)
            : await tx.execute(sql`
                SELECT 1 FROM business_managers
                 WHERE business_id = ${businessId} AND user_id = ${row.user_id}
                   AND removed_at IS NULL`);
        if (already.rows.length > 0)
          throw new OperationError('ALREADY_A_MEMBER');
      } else if (target.kind === 'email') {
        emailLower = target.email;
        const found = await tx.execute<{
          user_id: string;
          profile_id: string | null;
        }>(sql`
          SELECT u.id AS user_id, p.id AS profile_id FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
           WHERE lower(u.email) = ${emailLower} AND u.email_verified_at IS NOT NULL
             AND u.deleted_at IS NULL`);
        const row = found.rows[0];
        if (row) {
          // Blocked: the invitation is made (and simply expires), but nobody is told.
          if (await isBlocked(tx, businessId, row.user_id)) silent = true;
          else
            invitee = {
              profileId: row.profile_id,
              userId: row.user_id,
              email: null,
            };
        }
      }

      // The same open invitation again (same person, place and role) is not sent twice.
      if (target.kind !== 'link') {
        const open = await tx.execute<{ id: string }>(sql`
          SELECT id FROM business_invitations
           WHERE business_id = ${businessId} AND kind = ${input.kind}
             AND location_id IS NOT DISTINCT FROM ${locationId ?? null}::uuid
             AND manager_role IS NOT DISTINCT FROM ${role}::text
             AND target = ${target.kind}
             AND ${
               target.kind === 'email'
                 ? sql`email_lower = ${emailLower}::text`
                 : sql`invited_profile_id = ${invitee?.profileId ?? null}::uuid`
             }
             AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
             AND expires_at > ${now}
           LIMIT 1`);
        if (open.rows[0]) return { id: open.rows[0].id };
      }

      // Business Pro: a new staff invitation takes a seat until it is answered or expires.
      if (input.kind === 'staff' && opts.enforceLimits)
        await assertCanAddStaff(tx, businessId, {
          countInvitations: true,
          profileId: invitee?.profileId ?? null,
          now,
        });

      const id = newId();
      const code = newCode();
      const expiresAt = new Date(now.getTime() + INVITATION_DAYS * DAY_MS);
      await tx.execute(sql`
        INSERT INTO business_invitations
          (id, business_id, location_id, kind, manager_role, target, email_lower,
           invited_profile_id, code_sha256, invited_by, created_at, expires_at)
        VALUES (${id}, ${businessId}, ${locationId ?? null}::uuid, ${input.kind}, ${role},
                ${target.kind}, ${emailLower},
                ${target.kind === 'user' ? (invitee?.profileId ?? null) : null}::uuid,
                ${sha256(code)}, ${userId}, ${now}, ${expiresAt})`);

      const mailTo = silent
        ? null
        : target.kind === 'email'
          ? emailLower
          : (invitee?.email ?? null);
      if (mailTo)
        await enqueueMail(tx, sealing, {
          type: 'business_invitation',
          to: mailTo,
          userId: invitee?.userId ?? null,
          data: {
            code,
            businessName: business.name,
            ...(business.location_name
              ? { locationName: business.location_name }
              : {}),
            kind: input.kind,
            ...(role ? { role } : {}),
          },
          dedupeKey: `business_invitation.${id}`,
          expiresAt,
          now,
        });
      if (invitee)
        await tx.execute(sql`
          INSERT INTO notifications (id, user_id, kind, invitation_id, business_id, title, body, created_at)
          VALUES (${newId()}, ${invitee.userId}, 'business_invitation', ${id}, ${businessId},
                  ${`${business.name} invited you`},
                  ${
                    input.kind === 'staff'
                      ? `To receive tips at ${business.location_name ?? business.name}. Accept or decline on your Work page.`
                      : 'To help manage it on TipMe. Accept or decline on your Work page.'
                  },
                  ${now})
          ON CONFLICT DO NOTHING`);
      // The link is shown once: only its hash is kept. An email or username invitation's code
      // reaches only the person invited.
      return target.kind === 'link' ? { id, link: joinLink(code) } : { id };
    }),
  );
}

async function isBlocked(
  tx: Tx,
  businessId: string,
  userId: string,
): Promise<boolean> {
  const found = await tx.execute(sql`
    SELECT 1 FROM business_invitation_blocks
     WHERE business_id = ${businessId} AND user_id = ${userId}`);
  return found.rows.length > 0;
}

/**
 * A manager's list: open invitations and those of the last 30 days. An owner sees all of them; a
 * location manager only staff invitations to their location. The address shown is the one the
 * business typed itself; a username invitation shows the handle.
 */
export function listBusinessInvitations(
  db: Database,
  userId: string,
  businessId: string,
  now: Date = new Date(),
): Promise<InvitationRow[]> {
  return guarded(async () => {
    const manager = await managerOf(db, userId, businessId);
    const scope =
      manager.role === 'owner'
        ? sql``
        : sql`AND i.kind = 'staff' AND i.location_id = ${manager.locationId}`;
    const result = await db.execute<{
      id: string;
      kind: string;
      manager_role: string | null;
      location_id: string | null;
      target: string;
      email_lower: string | null;
      handle: string | null;
      accepted_at: unknown;
      declined_at: unknown;
      revoked_at: unknown;
      expires_at: Date | string;
    }>(sql`
      SELECT i.id, i.kind, i.manager_role, i.location_id, i.target, i.email_lower,
             p.handle, i.accepted_at, i.declined_at, i.revoked_at, i.expires_at
        FROM business_invitations i
        LEFT JOIN profiles p ON p.id = i.invited_profile_id AND p.page_state <> 'deleted'
       WHERE i.business_id = ${businessId} ${scope}
         AND (i.created_at > ${new Date(now.getTime() - 30 * DAY_MS)}
              OR (i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
                  AND i.expires_at > ${now}))
       ORDER BY i.created_at DESC, i.id
       LIMIT 100`);
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind as InvitationKind,
      ...(row.manager_role ? { role: row.manager_role as ManagerRole } : {}),
      ...(row.location_id ? { locationId: row.location_id } : {}),
      target: row.target as InvitationTarget,
      ...(row.email_lower ? { email: row.email_lower } : {}),
      ...(row.handle ? { handle: row.handle } : {}),
      state: stateOf(row, now),
      expiresAt: new Date(row.expires_at).toISOString(),
    }));
  });
}

/** A manager withdraws an open invitation: staff ones within their scope, manager ones as owner. */
export function revokeBusinessInvitation(
  db: Database,
  userId: string,
  businessId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId);
      if (!UUID.test(invitationId))
        throw new OperationError('INVITATION_INVALID');
      const found = await tx.execute<{
        kind: string;
        location_id: string | null;
        accepted_at: unknown;
        declined_at: unknown;
        revoked_at: unknown;
      }>(sql`
        SELECT kind, location_id, accepted_at, declined_at, revoked_at
          FROM business_invitations
         WHERE id = ${invitationId} AND business_id = ${businessId}
           FOR UPDATE`);
      const row = found.rows[0];
      if (!row) throw new OperationError('INVITATION_INVALID');
      await managerOf(tx, userId, businessId, {
        ...(row.kind === 'manager' ? { owner: true as const } : {}),
        ...(row.location_id ? { locationId: row.location_id } : {}),
      });
      if (row.accepted_at || row.declined_at || row.revoked_at)
        throw new OperationError('INVITATION_INVALID');
      await tx.execute(sql`
        UPDATE business_invitations SET revoked_at = ${now} WHERE id = ${invitationId}`);
    }),
  );
}

/**
 * A manager looks for a TipMe username to invite: at most 8 live, public pages whose handle starts
 * with the query, as their own public page shows them. Never an email, a phone or anything else
 * private; suspended, not live, hidden and deleted pages never show.
 */
export function searchInvitees(
  db: Database,
  userId: string,
  businessId: string,
  query: string,
): Promise<InviteeCard[]> {
  return guarded(async () => {
    await managerOf(db, userId, businessId);
    const prefix = query.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{2,30}$/.test(prefix)) return [];
    // `_` is a LIKE wildcard: escape it so "a_b" matches only itself.
    const pattern = `${prefix.replaceAll('_', '\\_')}%`;
    const result = await db.execute<{
      handle: string;
      display_name: string;
      avatar_path: string | null;
    }>(sql`
      SELECT p.handle, p.display_name, p.avatar_path
        FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE p.handle_lower LIKE ${pattern} AND ${INVITABLE_PAGE}
       ORDER BY (p.handle_lower = ${prefix}) DESC, p.handle_lower
       LIMIT 8`);
    return result.rows.map((row) => ({
      handle: row.handle,
      displayName: row.display_name,
      ...(row.avatar_path ? { avatarPath: row.avatar_path } : {}),
    }));
  });
}

type Found = {
  id: string;
  business_id: string;
  location_id: string | null;
  kind: string;
  manager_role: string | null;
  target: string;
  invited_by: string;
  business_name: string;
  business_status: string;
  location_name: string | null;
  user_email: string | null;
  profile_id: string | null;
  display_name: string | null;
  page_state: string | null;
  page_status: string | null;
};

/**
 * The invitation this person may answer, locked: open, unexpired, of a business TipMe has not
 * paused, at an open location, and addressed to them (any account for a link; the proven matching
 * address for an email; their own page for a username). Anything else is INVITATION_INVALID.
 */
async function answerable(
  tx: Tx,
  userId: string,
  answer: InvitationAnswer,
  now: Date,
): Promise<Found> {
  const which =
    'code' in answer
      ? sql`i.code_sha256 = ${sha256(answer.code)}`
      : // By id only for invitations addressed to an account: a link's id is not its secret.
        sql`i.id = ${answer.invitationId} AND i.target IN ('email', 'user')`;
  const result = await tx.execute<Found>(sql`
    SELECT i.id, i.business_id, i.location_id, i.kind, i.manager_role, i.target, i.invited_by,
           b.name AS business_name, b.status AS business_status, l.name AS location_name,
           CASE WHEN u.email_verified_at IS NOT NULL THEN lower(u.email) END AS user_email,
           p.id AS profile_id, p.display_name, p.page_state, p.status AS page_status
      FROM business_invitations i
      JOIN businesses b ON b.id = i.business_id
      LEFT JOIN business_locations l ON l.id = i.location_id
      JOIN users u ON u.id = ${userId} AND u.deleted_at IS NULL
      LEFT JOIN profiles p ON p.user_id = u.id
     WHERE ${which}
       AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > ${now}
       AND b.status <> 'suspended'
       AND (l.id IS NULL OR l.closed_at IS NULL)
       AND (i.target = 'link'
            OR (i.target = 'email' AND i.email_lower = lower(u.email) AND u.email_verified_at IS NOT NULL)
            OR (i.target = 'user' AND i.invited_profile_id = p.id))
       FOR UPDATE OF i`);
  const row = result.rows[0];
  if (!row) throw new OperationError('INVITATION_INVALID');
  return row;
}

const previewOf = (row: Found): InvitationPreview => ({
  businessName: row.business_name,
  ...(row.location_name ? { locationName: row.location_name } : {}),
  kind: row.kind as InvitationKind,
  ...(row.manager_role ? { role: row.manager_role as ManagerRole } : {}),
  verified: row.business_status === 'verified',
});

/** What an invitation is for, before the person answers it. */
export function previewBusinessInvitation(
  db: Database,
  userId: string,
  answer: InvitationAnswer,
  now: Date = new Date(),
): Promise<InvitationPreview> {
  return guarded(() =>
    db.transaction(async (tx) =>
      previewOf(await answerable(tx, userId, answer, now)),
    ),
  );
}

/**
 * The person joins with their own account. Staff need a live, active page (owner's answer Q1),
 * else MEMBER_NOT_TIPPABLE and the invitation stays open for when it is. Someone already on that
 * team, or already managing the business, gets ALREADY_A_MEMBER. The invitation row is locked,
 * so two accepts of one link make one membership.
 */
export function acceptBusinessInvitation(
  db: Database,
  userId: string,
  answer: InvitationAnswer,
  now: Date = new Date(),
  /** Business Pro (plan Task A4): the API passes BUSINESS_PRO_ENABLED. */
  opts: { enforceLimits?: boolean } = {},
): Promise<InvitationAccepted> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await answerable(tx, userId, answer, now);
      let accepted: InvitationAccepted;
      if (row.kind === 'staff') {
        if (
          !row.profile_id ||
          row.page_state !== 'live' ||
          row.page_status !== 'active'
        )
          throw new OperationError('MEMBER_NOT_TIPPABLE');
        // Accepting re-checks members only (ruling R4); refused, the invitation stays open.
        if (opts.enforceLimits)
          await assertCanAddStaff(tx, row.business_id, {
            countInvitations: false,
            profileId: row.profile_id,
            now,
          });
        const memberId = newId();
        const inserted = await tx.execute(sql`
          INSERT INTO business_members (id, location_id, profile_id, shown_name, invited_by, joined_at)
          VALUES (${memberId}, ${row.location_id}, ${row.profile_id},
                  ${firstNameOf(row.display_name ?? '') || 'Team'}, ${row.invited_by}, ${now})
          ON CONFLICT DO NOTHING
          RETURNING id`);
        if (inserted.rows.length === 0)
          throw new OperationError('ALREADY_A_MEMBER');
        accepted = {
          kind: 'staff',
          membership: await myMembership(tx, userId, memberId, now),
        };
      } else {
        const inserted = await tx.execute(sql`
          INSERT INTO business_managers (id, business_id, user_id, role, location_id, added_by, created_at)
          VALUES (${newId()}, ${row.business_id}, ${userId}, ${row.manager_role},
                  ${row.location_id}::uuid, ${row.invited_by}, ${now})
          ON CONFLICT DO NOTHING
          RETURNING id`);
        if (inserted.rows.length === 0)
          throw new OperationError('ALREADY_A_MEMBER');
        accepted = { kind: 'manager', businessId: row.business_id };
      }
      await tx.execute(sql`
        UPDATE business_invitations SET accepted_at = ${now}, accepted_by = ${userId}
         WHERE id = ${row.id}`);
      await tx.execute(sql`
        UPDATE notifications SET read_at = ${now}
         WHERE invitation_id = ${row.id} AND user_id = ${userId} AND read_at IS NULL`);
      return accepted;
    }),
  );
}

/** The person says no. The business sees "declined"; it may invite again unless blocked. */
export function declineBusinessInvitation(
  db: Database,
  userId: string,
  answer: InvitationAnswer,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await answerable(tx, userId, answer, now);
      await tx.execute(sql`
        UPDATE business_invitations SET declined_at = ${now} WHERE id = ${row.id}`);
      await tx.execute(sql`
        UPDATE notifications SET read_at = ${now}
         WHERE invitation_id = ${row.id} AND user_id = ${userId} AND read_at IS NULL`);
    }),
  );
}

/**
 * The invited person stops (or allows again) invitations from one business. Stopping also
 * declines whatever that business has open for them by username or email.
 */
export function setInvitationBlock(
  db: Database,
  userId: string,
  businessId: string,
  blocked: boolean,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!UUID.test(businessId))
        throw new OperationError('BUSINESS_NOT_FOUND');
      const exists = await tx.execute(sql`
        SELECT 1 FROM businesses WHERE id = ${businessId}`);
      if (exists.rows.length === 0)
        throw new OperationError('BUSINESS_NOT_FOUND');
      if (!blocked) {
        await tx.execute(sql`
          DELETE FROM business_invitation_blocks
           WHERE business_id = ${businessId} AND user_id = ${userId}`);
        return;
      }
      await tx.execute(sql`
        INSERT INTO business_invitation_blocks (business_id, user_id, created_at)
        VALUES (${businessId}, ${userId}, ${now}) ON CONFLICT DO NOTHING`);
      await tx.execute(sql`
        UPDATE business_invitations i SET declined_at = ${now}
          FROM users u LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.id = ${userId} AND i.business_id = ${businessId}
           AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
           AND ((i.target = 'email' AND u.email_verified_at IS NOT NULL
                 AND i.email_lower = lower(u.email))
                OR (i.target = 'user' AND i.invited_profile_id = p.id))`);
    }),
  );
}

/**
 * The Work page's invitations: open ones addressed to this account (by username or proven
 * email) from businesses it has not blocked, and the businesses it blocked.
 */
export function myInvitations(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<MyInvitations> {
  return guarded(async () => {
    const open = await db.execute<{
      id: string;
      business_id: string;
      business_name: string;
      business_status: string;
      location_name: string | null;
      kind: string;
      manager_role: string | null;
      expires_at: Date | string;
    }>(sql`
      SELECT i.id, i.business_id, b.name AS business_name, b.status AS business_status,
             l.name AS location_name, i.kind, i.manager_role, i.expires_at
        FROM business_invitations i
        JOIN businesses b ON b.id = i.business_id
        LEFT JOIN business_locations l ON l.id = i.location_id
        JOIN users u ON u.id = ${userId}
        LEFT JOIN profiles p ON p.user_id = u.id
       WHERE i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
         AND i.expires_at > ${now}
         AND b.status <> 'suspended' AND (l.id IS NULL OR l.closed_at IS NULL)
         AND ((i.target = 'email' AND u.email_verified_at IS NOT NULL
               AND i.email_lower = lower(u.email))
              OR (i.target = 'user' AND i.invited_profile_id = p.id))
         AND NOT EXISTS (SELECT 1 FROM business_invitation_blocks k
                          WHERE k.business_id = i.business_id AND k.user_id = u.id)
       ORDER BY i.created_at DESC, i.id
       LIMIT 50`);
    const blocked = await db.execute<{ business_id: string; name: string }>(sql`
      SELECT k.business_id, b.name FROM business_invitation_blocks k
        JOIN businesses b ON b.id = k.business_id
       WHERE k.user_id = ${userId}
       ORDER BY b.name, b.id`);
    return {
      invitations: open.rows.map((row) => ({
        id: row.id,
        businessId: row.business_id,
        businessName: row.business_name,
        ...(row.location_name ? { locationName: row.location_name } : {}),
        kind: row.kind as InvitationKind,
        ...(row.manager_role ? { role: row.manager_role as ManagerRole } : {}),
        verified: row.business_status === 'verified',
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
      blocked: blocked.rows.map((row) => ({
        businessId: row.business_id,
        name: row.name,
      })),
    };
  });
}
