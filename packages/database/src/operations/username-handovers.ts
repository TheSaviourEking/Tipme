import { createHash, randomBytes } from 'node:crypto';
import {
  CLAIM_LINK_CODE,
  CLAIM_LINK_PATH,
  CLAIM_LINK_PREFIX,
  HANDOVER_LINK_DAYS,
  type ClaimLinkPreview,
  type OpsHandoverAccount,
  type OpsHandoverLink,
  type UsernameHandedOver,
} from '@tipme/contracts';
import { isReservedHandle, reservationKey } from '@tipme/domain';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  handleAliases,
  handleHandoverLinks,
  handleHolds,
  handleReservations,
  handleTakeBacks,
  profiles,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import { mailOwner } from './account-mail.js';
import type { MailSealing } from './mail-queue.js';
import { opsPageByHandle } from './profiles.js';
import {
  checkedReason,
  isActiveStaff,
  readStaffAccess,
  readStaffAccessOf,
  withAuditChange,
} from './staff.js';
import { pendingTakeBacks } from './username-take-backs.js';

/*
 * Username handover (owner's approval, 18 Nov 2026; reservation spec, "Handover"). A reserved name
 * moves to one account, either through a one-time claim link staff copy and send themselves, or by
 * staff giving it to an account they found. Nobody loses a name: only a reserved name moves, and
 * the account keeps its old username as a redirect. So there is no second approver.
 *
 * The name stays reserved until the handover commits. The reservation ends and the handle is set in
 * one transaction. Lock order, as for take-backs and renames: the account's profile row, then the
 * name's per-handle advisory lock (the reservation code and the 0028/0072 triggers take the same
 * one), then the link and reservation rows. A sign-up meanwhile still sees the reservation and is
 * refused; a release or a second claim waits for the lock, then finds the reservation gone.
 *
 * Only the sha256 of a link's code is stored. The code is never logged, audited or put in a URL a
 * server sees (it lives in the fragment); the audit names the link and the reservation instead.
 */

const PERMISSION = 'usernames.manage';
const DAY_MS = 86_400_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** 24 characters of base32: 120 random bits (256 is a multiple of 32, so each is uniform). */
const newCode = () =>
  Array.from(randomBytes(24), (byte) => BASE32[byte & 31]).join('');
const claimPath = (code: string) =>
  `${CLAIM_LINK_PATH}${CLAIM_LINK_PREFIX}${code}`;

const isBuiltIn = (raw: string) => isReservedHandle(raw.trim());

/** The same key as username-reservations.ts and the triggers of 0028 and 0072. */
const lockName = (tx: Tx, key: string) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`tipme.handle:${key}`}::text))`,
  );

/** A built-in word is refused on the name as typed; anything else must fold to a key. */
function keyOf(raw: string): string {
  if (isBuiltIn(raw)) throw new OperationError('USERNAME_BUILT_IN');
  const key = reservationKey(raw);
  if (!key) throw new OperationError('USERNAME_NOT_RESERVED');
  return key;
}

async function lockedReservation(tx: Tx, key: string) {
  const [row] = await tx
    .select()
    .from(handleReservations)
    .where(
      and(
        eq(handleReservations.handleLower, key),
        isNull(handleReservations.releasedAt),
      ),
    )
    .for('update');
  return row ?? null;
}

/** A deleted page's 90-day hold still protects that page's old links: the name waits. */
async function holdUntil(
  db: Database | Tx,
  key: string,
  now: Date,
): Promise<Date | null> {
  const [hold] = await db
    .select({ until: handleHolds.until })
    .from(handleHolds)
    .where(and(eq(handleHolds.handleLower, key), gt(handleHolds.until, now)));
  return hold?.until ?? null;
}

const linkColumns = {
  id: handleHandoverLinks.id,
  name: handleHandoverLinks.handleLower,
  createdAt: handleHandoverLinks.createdAt,
  expiresAt: handleHandoverLinks.expiresAt,
  email: users.email,
};

const toLink = (row: {
  id: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  email: string | null;
}): OpsHandoverLink => ({
  id: row.id,
  name: row.name,
  createdBy: row.email ? maskEmail(row.email) : null,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

const openLinkOf = (reservationId: string) =>
  and(
    eq(handleHandoverLinks.reservationId, reservationId),
    isNull(handleHandoverLinks.usedAt),
    isNull(handleHandoverLinks.cancelledAt),
  );

/** The open claim link of a reservation, as staff see it (an expired one is still shown). */
export async function openHandoverLink(
  db: Database | Tx,
  reservationId: string,
): Promise<OpsHandoverLink | null> {
  const [row] = await db
    .select(linkColumns)
    .from(handleHandoverLinks)
    .leftJoin(users, eq(users.id, handleHandoverLinks.createdBy))
    .where(openLinkOf(reservationId));
  return row ? toLink(row) : null;
}

/**
 * Ends the open link of a reservation, if any. `staffId` null means TipMe ended it: the reservation
 * was released or the name given to an account. The caller holds the name's lock.
 */
export async function cancelOpenHandoverLinks(
  tx: Tx,
  input: {
    reservationId: string;
    staffId: string | null;
    reason: string;
    now: Date;
  },
): Promise<string | null> {
  const [cancelled] = await tx
    .update(handleHandoverLinks)
    .set({
      cancelledAt: input.now,
      cancelledBy: input.staffId,
      cancelReason: input.reason,
    })
    .where(openLinkOf(input.reservationId))
    .returning({ id: handleHandoverLinks.id });
  return cancelled?.id ?? null;
}

/**
 * Ends every open claim link whose maker is no longer staff holding usernames.manage, after a staff
 * change (removal, a role move, a role edit, a personal removal; security review of PR #280). Each
 * one is audited as `username.handover_link_cancelled`, "staff access changed". A claim and a preview
 * check the maker's access too, so a change made some other way still stops the link working.
 * `actorId` is who made the staff change. Run after the change, in its transaction.
 */
export async function endLinksOfStaffWithoutAccess(
  tx: Tx,
  input: { actorId: string; now: Date },
): Promise<number> {
  const open = await tx
    .select({
      id: handleHandoverLinks.id,
      name: handleHandoverLinks.handleLower,
      reservationId: handleHandoverLinks.reservationId,
      makerId: handleHandoverLinks.createdBy,
    })
    .from(handleHandoverLinks)
    .where(
      and(
        isNull(handleHandoverLinks.usedAt),
        isNull(handleHandoverLinks.cancelledAt),
      ),
    );
  if (open.length === 0) return 0;
  const access = await readStaffAccessOf(tx, [
    ...new Set(open.map((link) => link.makerId)),
  ]);
  const ending = open.filter(
    (link) => !access.get(link.makerId)?.permissions.has(PERMISSION),
  );
  for (const link of ending) {
    await tx
      .update(handleHandoverLinks)
      .set({
        cancelledAt: input.now,
        cancelledBy: input.actorId,
        cancelReason: 'Staff access changed',
      })
      .where(eq(handleHandoverLinks.id, link.id));
    await recordAudit(tx, {
      staffUserId: input.actorId,
      action: 'username.handover_link_cancelled',
      permission: PERMISSION,
      subjectType: 'username',
      subjectId: link.name,
      reason: withAuditChange(
        'Staff access changed: its maker no longer manages usernames',
        {
          reservationId: link.reservationId,
          linkId: link.id,
          makerId: link.makerId,
        },
      ),
      now: input.now,
    });
  }
  return ending.length;
}

/** Only staff holding usernames.manage act here, whatever the route checked first. */
async function assertManages(tx: Tx, staffId: string): Promise<void> {
  const access = await readStaffAccess(tx, staffId);
  if (!access?.permissions.has(PERMISSION))
    throw new OperationError('PERMISSION_NOT_HELD');
}

/**
 * Staff make a claim link for a reserved name, valid HANDOVER_LINK_DAYS days. A new link cancels the
 * open one. The code is returned once, here, and never stored. Audited as
 * `username.handover_link_created` with the reservation and the link, not the code.
 */
export function createHandoverLink(
  db: Database,
  input: { staffId: string; name: string; reason: string; now?: Date },
): Promise<{ link: OpsHandoverLink; path: string }> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const key = keyOf(input.name);
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      await assertManages(tx, input.staffId);
      await lockName(tx, key);
      const reservation = await lockedReservation(tx, key);
      if (!reservation) throw new OperationError('USERNAME_NOT_RESERVED');
      if (await holdUntil(tx, key, now))
        throw new OperationError('USERNAME_IN_HOLD');
      const replaced = await cancelOpenHandoverLinks(tx, {
        reservationId: reservation.id,
        staffId: input.staffId,
        reason: 'Replaced by a new claim link',
        now,
      });
      const code = newCode();
      const id = newId();
      const expiresAt = new Date(now.getTime() + HANDOVER_LINK_DAYS * DAY_MS);
      await tx.insert(handleHandoverLinks).values({
        id,
        reservationId: reservation.id,
        handleLower: key,
        tokenSha256: sha256(code),
        createdBy: input.staffId,
        createdAt: now,
        expiresAt,
      });
      await recordAudit(tx, {
        staffUserId: input.staffId,
        action: 'username.handover_link_created',
        permission: PERMISSION,
        subjectType: 'username',
        subjectId: key,
        reason: withAuditChange(reason, {
          reservationId: reservation.id,
          linkId: id,
          expiresAt: expiresAt.toISOString(),
          ...(replaced ? { replacedLinkId: replaced } : {}),
        }),
        now,
      });
      return {
        link: (await openHandoverLink(tx, reservation.id))!,
        path: claimPath(code),
      };
    });
  });
}

/** Staff cancel a reservation's open claim link. The name stays reserved. Audited. */
export function cancelHandoverLink(
  db: Database,
  input: { staffId: string; name: string; reason: string; now?: Date },
): Promise<OpsHandoverLink> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const key = keyOf(input.name);
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      await lockName(tx, key);
      const reservation = await lockedReservation(tx, key);
      if (!reservation) throw new OperationError('USERNAME_NOT_RESERVED');
      const link = await openHandoverLink(tx, reservation.id);
      if (!link) throw new OperationError('HANDOVER_LINK_NOT_FOUND');
      await cancelOpenHandoverLinks(tx, {
        reservationId: reservation.id,
        staffId: input.staffId,
        reason,
        now,
      });
      await recordAudit(tx, {
        staffUserId: input.staffId,
        action: 'username.handover_link_cancelled',
        permission: PERMISSION,
        subjectType: 'username',
        subjectId: key,
        reason: withAuditChange(reason, {
          reservationId: reservation.id,
          linkId: link.id,
        }),
        now,
      });
      return link;
    });
  });
}

/** The link a code belongs to, if any; a code that isn't one is never looked up. */
async function linkByCode(db: Database | Tx, raw: string) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!CLAIM_LINK_CODE.test(code)) return null;
  const [row] = await db
    .select()
    .from(handleHandoverLinks)
    .where(eq(handleHandoverLinks.tokenSha256, sha256(code)));
  return row ?? null;
}

type LinkRow = typeof handleHandoverLinks.$inferSelect;

/** A link is open while unused, uncancelled, unexpired and its reservation still active. */
function stateOf(
  link: LinkRow,
  reservationActive: boolean,
  now: Date,
): ClaimLinkPreview['state'] {
  if (link.usedAt) return 'used';
  if (link.cancelledAt || !reservationActive) return 'cancelled';
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'open';
}

async function reservationActive(db: Database | Tx, id: string) {
  const [row] = await db
    .select({ id: handleReservations.id })
    .from(handleReservations)
    .where(
      and(eq(handleReservations.id, id), isNull(handleReservations.releasedAt)),
    );
  return row !== undefined;
}

/** What a claim link is, for anyone holding it. Only an open link names its username. */
export function previewHandoverLink(
  db: Database,
  code: string,
  now: Date = new Date(),
): Promise<ClaimLinkPreview> {
  return guarded(async () => {
    const link = await linkByCode(db, code);
    if (!link) return { state: 'invalid' };
    // A link whose maker no longer manages usernames can't be claimed, so it reads as cancelled and
    // names nothing, as the claim answers (security review of PR #280).
    const maker = await readStaffAccess(db, link.createdBy);
    const state = stateOf(
      link,
      (await reservationActive(db, link.reservationId)) &&
        maker?.permissions.has(PERMISSION) === true,
      now,
    );
    return state === 'open'
      ? {
          state,
          name: link.handleLower,
          expiresAt: link.expiresAt.toISOString(),
        }
      : { state };
  });
}

/** The account's page row, locked first (the lock order above); null when it has none. */
async function lockedAccount(tx: Tx, userId: string) {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (!account) throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
  const pageRow = () =>
    tx.select().from(profiles).where(eq(profiles.userId, userId)).for('update');
  const [page] = await pageRow();
  if (page) return page;
  // No page yet: the account's row, so two handovers to one account take turns. FOR NO KEY UPDATE,
  // not FOR UPDATE: a sign-up's new page checks its reference to the account with KEY SHARE after
  // inserting, and FOR UPDATE would deadlock with it. A sign-up that lands first wins; this one then
  // meets profiles_user_id_unique and answers HANDOVER_ACCOUNT_CHANGED (try again).
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  const [made] = await pageRow();
  return made ?? null;
}

/**
 * The one handover, inside the caller's transaction, which holds the profile lock then the name's
 * lock and has checked the reservation is active. Ends the reservation, then gives the name to the
 * page (the 0072 trigger allows it once nobody reserves it), keeping the old username as a
 * redirect. Not a handle change the page makes, so no change is counted, on any plan.
 */
async function handOver(
  tx: Tx,
  input: {
    key: string;
    reservation: typeof handleReservations.$inferSelect;
    page: typeof profiles.$inferSelect | null;
    userId: string;
    releasedBy: string;
    releaseReason: string;
    now: Date;
  },
): Promise<Omit<UsernameHandedOver, 'name'>> {
  const { key, page, now } = input;
  // A word added to TipMe's own list after the name was reserved is never handed out.
  if (isReservedHandle(key)) throw new OperationError('USERNAME_BUILT_IN');
  const [account] = await tx
    .select({ status: users.status, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, input.userId));
  if (!account || account.deletedAt || account.status !== 'active')
    throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
  // No active staff account receives a name (controller ruling, security review of PR #280):
  // nobody gives a name to themselves, and two staff can't pass one between them.
  if (await isActiveStaff(tx, input.userId))
    throw new OperationError('HANDOVER_STAFF_ACCOUNT');
  if (page) {
    if (
      page.pageState === 'deleted' ||
      page.rehearsalRunId ||
      page.status === 'suspended'
    )
      throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
    // A take-back of one of its names waiting for a second person, as the Usernames check reads it.
    if (
      (await pendingTakeBacks(tx, now)).some(
        (request) => request.profileId === page.id,
      )
    )
      throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
    // A take-back of one of its names is under way: that finishes first (or is cancelled).
    const [takeBack] = await tx
      .select({ id: handleTakeBacks.id })
      .from(handleTakeBacks)
      .where(
        and(
          eq(handleTakeBacks.profileId, page.id),
          inArray(handleTakeBacks.state, ['approved', 'noticed', 'due']),
        ),
      );
    if (takeBack) throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
  }
  if (await holdUntil(tx, key, now))
    throw new OperationError('USERNAME_IN_HOLD');
  const profileId = page?.id ?? newId();
  await tx
    .update(handleReservations)
    .set({
      releasedAt: now,
      releasedBy: input.releasedBy,
      releaseReason: input.releaseReason,
    })
    .where(eq(handleReservations.id, input.reservation.id));
  if (page) {
    await tx
      .insert(handleAliases)
      .values({ handleLower: page.handleLower, profileId: page.id });
    await tx
      .update(profiles)
      .set({ handle: key, handleLower: key })
      .where(eq(profiles.id, page.id));
  } else {
    // As claimHandle: not live, named after the handle.
    await tx.insert(profiles).values({
      id: profileId,
      userId: input.userId,
      handle: key,
      handleLower: key,
      displayName: key,
      pageState: 'not_live',
    });
  }
  // After the page exists: the reference must point at a row.
  await tx
    .update(handleReservations)
    .set({ handedOverTo: profileId })
    .where(eq(handleReservations.id, input.reservation.id));
  return {
    handle: key,
    previous: page?.handleLower ?? null,
    profileId,
    created: !page,
  };
}

/** The constraint a database refusal names, if any. */
function constraintOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === 'string') return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A unique violation here: the account got a page some other way at that moment (worth trying
 * again), or a write that took no lock (an older release) means the name is not free.
 */
const raced = (
  error: unknown,
  code: 'CLAIM_LINK_INVALID' | 'USERNAME_NOT_RESERVED',
) => {
  if (sqlStateOf(error) === '23505')
    throw new OperationError(
      constraintOf(error) === 'profiles_user_id_unique'
        ? 'HANDOVER_ACCOUNT_CHANGED'
        : code,
    );
  throw error;
};

/**
 * The signed-in person claims the name a link is for. Their page takes the name (or, with no page,
 * one is made); their old username keeps leading to the page. The link is then used. Audited as
 * `username.claimed_via_link`, by the person, naming the link and the reservation, never the code.
 * Any link that isn't open is CLAIM_LINK_INVALID; the preview says which.
 */
export function claimViaHandoverLink(
  db: Database,
  input: {
    userId: string;
    code: string;
    now?: Date;
    /** LIVE_CHECKOUT_HANDLES: a listed page that is renamed loses live checkout, so it is recorded. */
    liveCheckoutHandles?: readonly string[];
  },
): Promise<UsernameHandedOver> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const found = await linkByCode(db, input.code);
    if (!found) throw new OperationError('CLAIM_LINK_INVALID');
    const key = found.handleLower;
    try {
      return await db.transaction(async (tx) => {
        const page = await lockedAccount(tx, input.userId);
        await lockName(tx, key);
        const [link] = await tx
          .select()
          .from(handleHandoverLinks)
          .where(eq(handleHandoverLinks.id, found.id))
          .for('update');
        const reservation = await lockedReservation(tx, key);
        if (
          !link ||
          !reservation ||
          reservation.id !== link.reservationId ||
          stateOf(link, true, now) !== 'open'
        )
          throw new OperationError('CLAIM_LINK_INVALID');
        // A link lasts only while its maker is still staff holding the permission.
        const maker = await readStaffAccess(tx, link.createdBy);
        if (!maker?.permissions.has(PERMISSION))
          throw new OperationError('CLAIM_LINK_INVALID');
        const result = await handOver(tx, {
          key,
          reservation,
          page,
          userId: input.userId,
          // Who let it go: the staff member who made the link.
          releasedBy: link.createdBy,
          releaseReason: `Claimed through a claim link (${link.id})`,
          now,
        });
        await tx
          .update(handleHandoverLinks)
          .set({ usedAt: now, usedBy: input.userId })
          .where(eq(handleHandoverLinks.id, link.id));
        await recordAudit(tx, {
          staffUserId: input.userId,
          action: 'username.claimed_via_link',
          subjectType: 'username',
          subjectId: key,
          reason: withAuditChange('Claimed through a claim link', {
            reservationId: reservation.id,
            linkId: link.id,
            linkCreatedBy: link.createdBy,
            profileId: result.profileId,
            previous: result.previous,
            ...(result.previous &&
            input.liveCheckoutHandles?.includes(result.previous)
              ? { liveCheckoutListed: true }
              : {}),
          }),
          now,
        });
        return { name: key, ...result };
      });
    } catch (error) {
      return raced(error, 'CLAIM_LINK_INVALID');
    }
  });
}

/**
 * Staff give a reserved name to an account (`usernames.manage`, a reason), with no second person:
 * nobody loses a name (owner's call, 18 Nov 2026). The account's page takes the name, and its old
 * username keeps leading there; an account with no page gets one. An open claim link is cancelled.
 * Audited as `username.assigned`.
 */
export function assignUsername(
  db: Database,
  input: {
    staffId: string;
    name: string;
    userId: string;
    reason: string;
    now?: Date;
    /** To email the person their new username; absent only where no mail key is at hand. */
    sealing?: MailSealing;
  },
): Promise<UsernameHandedOver> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const key = keyOf(input.name);
    const reason = checkedReason(input.reason);
    if (!UUID.test(input.userId))
      throw new OperationError('HANDOVER_ACCOUNT_UNAVAILABLE');
    try {
      return await db.transaction(async (tx) => {
        await assertManages(tx, input.staffId);
        const page = await lockedAccount(tx, input.userId);
        await lockName(tx, key);
        const reservation = await lockedReservation(tx, key);
        if (!reservation) throw new OperationError('USERNAME_NOT_RESERVED');
        const result = await handOver(tx, {
          key,
          reservation,
          page,
          userId: input.userId,
          releasedBy: input.staffId,
          releaseReason: reason,
          now,
        });
        const cancelledLinkId = await cancelOpenHandoverLinks(tx, {
          reservationId: reservation.id,
          staffId: null,
          reason: 'The username was given to an account',
          now,
        });
        // The person is told, in fixed words: never the staff reason (controller ruling).
        if (input.sealing)
          await mailOwner(tx, input.sealing, {
            userId: input.userId,
            type: 'username_assigned',
            data: { new: key, old: result.previous },
            dedupeKey: `username_assigned.${reservation.id}`,
            now,
          });
        await recordAudit(tx, {
          staffUserId: input.staffId,
          action: 'username.assigned',
          permission: PERMISSION,
          subjectType: 'username',
          subjectId: key,
          reason: withAuditChange(reason, {
            reservationId: reservation.id,
            userId: input.userId,
            profileId: result.profileId,
            previous: result.previous,
            ...(cancelledLinkId ? { cancelledLinkId } : {}),
          }),
          now,
        });
        return { name: key, ...result };
      });
    } catch (error) {
      return raced(error, 'USERNAME_NOT_RESERVED');
    }
  });
}

/**
 * Staff find the account to give a name to: by its current username, or by its whole confirmed
 * email (never part of one). The answer carries public-level page fields only, as admin search
 * does: no email, phone or balance. Deleted accounts and pages are not found.
 */
export function findHandoverAccounts(
  db: Database,
  raw: string,
): Promise<OpsHandoverAccount[]> {
  return guarded(async () => {
    const query = raw.trim();
    if (query.includes('@') && !query.startsWith('@')) {
      const email = normaliseEmail(query);
      if (!email) return [];
      const [account] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            sql`${users.emailVerifiedAt} IS NOT NULL`,
            isNull(users.deletedAt),
          ),
        );
      if (!account) return [];
      const found = await accountOf(db, account.id, 'email');
      return found ? [found] : [];
    }
    const handle = reservationKey(query.replace(/^@/, ''));
    if (!handle) return [];
    const [row] = await db
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.handleLower, handle),
          ne(profiles.pageState, 'deleted'),
          isNull(users.deletedAt),
        ),
      );
    if (!row?.userId) return [];
    const found = await accountOf(db, row.userId, 'username');
    return found ? [found] : [];
  });
}

async function accountOf(
  db: Database,
  userId: string,
  foundBy: OpsHandoverAccount['foundBy'],
): Promise<OpsHandoverAccount | null> {
  const [page] = await db
    .select({
      handleLower: profiles.handleLower,
      pageState: profiles.pageState,
      rehearsalRunId: profiles.rehearsalRunId,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  // A deleted page or a release-check page can't take a name: not offered at all.
  if (page && (page.pageState === 'deleted' || page.rehearsalRunId))
    return null;
  return {
    userId,
    foundBy,
    page: page ? await opsPageByHandle(db, page.handleLower) : null,
    // Staff accounts can't receive a name: the screen says so instead of offering Give.
    staff: await isActiveStaff(db, userId),
  };
}
