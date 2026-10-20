import {
  profilePatchSchema,
  type HandleStatus,
  type MyProfile,
  type ProfilePatch,
  type PublicProfile,
  type Socials,
} from '@tipme/contracts';
import { isReservedHandle, normaliseHandle } from '@tipme/domain';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  emailTokens,
  handleHolds,
  phoneRecoveries,
  profiles,
  sessions,
  signInCodes,
  signInLockouts,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { isOpenReleaseRun } from './release-runs.js';
import { balanceIn } from './balance.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { publicCelebration } from './moments.js';

export const HANDLE_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

/** Whether the user has claimed a page yet. */
export function hasProfile(db: Database, userId: string): Promise<boolean> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    return row !== undefined;
  });
}

export function checkHandle(
  db: Database,
  raw: string,
  now: Date,
): Promise<HandleStatus> {
  const handle = normaliseHandle(raw);
  if (!handle) return Promise.resolve('invalid');
  if (isReservedHandle(handle)) return Promise.resolve('reserved');
  return guarded(async () =>
    (await isTaken(db, handle, now)) ? 'taken' : 'available',
  );
}

async function isTaken(
  db: Database,
  handle: string,
  now: Date,
): Promise<boolean> {
  const [profile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.handleLower, handle));
  if (profile) return true;
  const [hold] = await db
    .select({ until: handleHolds.until })
    .from(handleHolds)
    .where(
      and(eq(handleHolds.handleLower, handle), gt(handleHolds.until, now)),
    );
  return hold !== undefined;
}

/** Claims a handle for the user's one page. The page starts not live, named after the handle. */
export function claimHandle(
  db: Database,
  input: {
    userId: string;
    handle: string;
    now?: Date;
    /** Release check only (PR-010): honoured only for an open run. */
    rehearsalRunId?: string;
  },
): Promise<{ profileId: string; handle: string }> {
  const now = input.now ?? new Date();
  const handle = normaliseHandle(input.handle);
  return guarded(async () => {
    if (!handle) throw new OperationError('INVALID_INPUT');
    if (await hasProfile(db, input.userId))
      throw new OperationError('ALREADY_HAS_PAGE');
    if (isReservedHandle(handle) || (await isTaken(db, handle, now)))
      throw new OperationError('HANDLE_TAKEN');
    const profileId = newId();
    const rehearsalRunId = (await isOpenReleaseRun(db, input.rehearsalRunId))
      ? input.rehearsalRunId
      : null;
    const inserted = await db
      .insert(profiles)
      .values({
        id: profileId,
        rehearsalRunId,
        userId: input.userId,
        handle,
        handleLower: handle,
        displayName: handle,
        pageState: 'not_live',
      })
      .onConflictDoNothing()
      .returning({ id: profiles.id });
    // Lost a race for the same handle (or the same user claimed twice at once).
    if (!inserted[0]) {
      if (await hasProfile(db, input.userId))
        throw new OperationError('ALREADY_HAS_PAGE');
      throw new OperationError('HANDLE_TAKEN');
    }
    return { profileId, handle };
  });
}

async function myRow(db: Database, userId: string) {
  const [row] = await db
    .select({
      profile: profiles,
      phone: users.phoneE164,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(
      and(
        eq(profiles.userId, userId),
        eq(profiles.pageState, profiles.pageState),
      ),
    );
  if (!row || row.profile.pageState === 'deleted')
    throw new OperationError('NO_PAGE');
  return row;
}

const toMine = (row: Awaited<ReturnType<typeof myRow>>): MyProfile => ({
  handle: row.profile.handle,
  displayName: row.profile.displayName,
  role: row.profile.role,
  bio: row.profile.bio,
  socials: row.profile.socials as Socials,
  bioPublic: row.profile.bioPublic,
  socialsPublic: row.profile.socialsPublic,
  phonePublic: row.profile.phonePublic,
  emailPublic: row.profile.emailPublic,
  pageState: row.profile.pageState as MyProfile['pageState'],
  qrStyle: row.profile.qrStyle,
  phone: row.phone,
  email: row.email,
  emailVerified: row.emailVerifiedAt !== null,
  suspended: row.profile.status === 'suspended',
  suspendedReason:
    row.profile.status === 'suspended' ? row.profile.suspendedReason : null,
});

export function getMyProfile(db: Database, userId: string): Promise<MyProfile> {
  return guarded(async () => toMine(await myRow(db, userId)));
}

/** The profile id of the user's page (not deleted), for routes that act on it. */
export function myProfileId(db: Database, userId: string): Promise<string> {
  return guarded(async () => (await myRow(db, userId)).profile.id);
}

export function updateMyProfile(
  db: Database,
  userId: string,
  patch: ProfilePatch,
): Promise<MyProfile> {
  return guarded(async () => {
    const parsed = profilePatchSchema.safeParse(patch);
    if (!parsed.success) throw new OperationError('INVALID_INPUT');
    const row = await myRow(db, userId);
    const values = parsed.data;
    await db
      .update(profiles)
      .set({
        ...(values.displayName !== undefined
          ? { displayName: values.displayName }
          : {}),
        ...(values.role !== undefined ? { role: values.role || null } : {}),
        ...(values.bio !== undefined ? { bio: values.bio || null } : {}),
        ...(values.socials !== undefined ? { socials: values.socials } : {}),
        ...(values.bioPublic !== undefined
          ? { bioPublic: values.bioPublic }
          : {}),
        ...(values.socialsPublic !== undefined
          ? { socialsPublic: values.socialsPublic }
          : {}),
        ...(values.phonePublic !== undefined
          ? { phonePublic: values.phonePublic }
          : {}),
        ...(values.emailPublic !== undefined
          ? { emailPublic: values.emailPublic }
          : {}),
        ...(values.qrStyle !== undefined ? { qrStyle: values.qrStyle } : {}),
      })
      .where(eq(profiles.id, row.profile.id));
    return toMine(await myRow(db, userId));
  });
}

export function setPageState(
  db: Database,
  userId: string,
  state: 'live' | 'not_live',
): Promise<{ handle: string }> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    // A page TipMe suspended can be taken offline but not put back live (PR-009).
    if (state === 'live' && row.profile.status === 'suspended')
      throw new OperationError('PAGE_SUSPENDED');
    await db
      .update(profiles)
      .set({ pageState: state })
      .where(eq(profiles.id, row.profile.id));
    return { handle: row.profile.handle };
  });
}

/** A live page's public details; null for unknown, not live, deleted and suspended pages alike. */
export function publicProfile(
  db: Database,
  raw: string,
): Promise<PublicProfile | null> {
  const handle = normaliseHandle(raw);
  if (!handle) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({
        profile: profiles,
        phone: users.phoneE164,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(profiles)
      .leftJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.handleLower, handle),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
        ),
      );
    if (!row) return null;
    const { profile } = row;
    const socials = profile.socials as Socials;
    const celebration = await publicCelebration(db, profile.id);
    return {
      handle: profile.handle,
      displayName: profile.displayName,
      ...(profile.role ? { role: profile.role } : {}),
      ...(profile.craft ? { craft: profile.craft } : {}),
      ...(profile.note ? { note: profile.note } : {}),
      ...(profile.avatarPath ? { avatarPath: profile.avatarPath } : {}),
      ...(profile.bio && profile.bioPublic ? { bio: profile.bio } : {}),
      ...(profile.socialsPublic && Object.keys(socials).length > 0
        ? { socials }
        : {}),
      ...(profile.phonePublic && row.phone ? { phone: row.phone } : {}),
      ...(profile.emailPublic && row.email && row.emailVerifiedAt
        ? { email: row.email }
        : {}),
      ...(celebration ? { celebration } : {}),
    };
  });
}

/**
 * Deletes the page and the account: personal details are erased, every session ends, the handle
 * is held for 90 days, and money records stay (they reference ids only). Refused while money is
 * owed or still confirming.
 */
export function deleteAccount(
  db: Database,
  input: { userId: string; now?: Date },
): Promise<{ handle: string }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: profiles.id,
          handleLower: profiles.handleLower,
          pageState: profiles.pageState,
        })
        .from(profiles)
        .where(eq(profiles.userId, input.userId))
        .for('update');
      if (row && row.pageState !== 'deleted') {
        const balance = await balanceIn(tx, row.id);
        if (balance.availableMinor > 0n || balance.confirmingMinor > 0n)
          throw new OperationError('HAS_BALANCE');
        await tx
          .update(profiles)
          .set({
            pageState: 'deleted',
            handle: 'deleted',
            handleLower: `deleted:${row.id}`,
            displayName: 'Deleted page',
            role: null,
            bio: null,
            craft: null,
            note: null,
            avatarPath: null,
            socials: {},
            phonePublic: false,
            emailPublic: false,
          })
          .where(eq(profiles.id, row.id));
        await tx
          .insert(handleHolds)
          .values({
            handleLower: row.handleLower,
            until: new Date(now.getTime() + HANDLE_HOLD_MS),
          })
          .onConflictDoUpdate({
            target: handleHolds.handleLower,
            set: { until: new Date(now.getTime() + HANDLE_HOLD_MS) },
          });
      }
      // Erase what identifies the person, including codes, lockouts and pending links or recoveries.
      const [person] = await tx
        .select({ phone: users.phoneE164 })
        .from(users)
        .where(eq(users.id, input.userId));
      if (person?.phone) {
        await tx
          .delete(signInCodes)
          .where(eq(signInCodes.phoneE164, person.phone));
        await tx
          .delete(signInLockouts)
          .where(eq(signInLockouts.phoneE164, person.phone));
      }
      await tx
        .update(emailTokens)
        .set({ usedAt: now })
        .where(
          and(eq(emailTokens.userId, input.userId), isNull(emailTokens.usedAt)),
        );
      await tx
        .update(phoneRecoveries)
        .set({ cancelledAt: now })
        .where(
          and(
            eq(phoneRecoveries.userId, input.userId),
            isNull(phoneRecoveries.cancelledAt),
            isNull(phoneRecoveries.completedAt),
          ),
        );
      await tx
        .update(users)
        .set({
          phoneE164: null,
          email: null,
          emailVerifiedAt: null,
          deletedAt: now,
        })
        .where(eq(users.id, input.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(eq(sessions.userId, input.userId));
      return { handle: row?.handleLower ?? '' };
    }),
  );
}
export { normaliseHandle } from '@tipme/domain';

/**
 * Staff pause or restore a page (permission `pages.suspend`). A suspended page shows as unavailable
 * and takes no new tips; tips already in flight settle and withdrawals stay allowed (ADR-0010).
 */
export function setPageSuspension(
  db: Database,
  input: {
    profileId: string;
    staffUserId: string;
    suspend: boolean;
    reason: string;
  },
): Promise<{ handle: string }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(profiles)
        .set(
          input.suspend
            ? { status: 'suspended', suspendedReason: input.reason }
            : { status: 'active', suspendedReason: null },
        )
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        )
        .returning({ handle: profiles.handle });
      if (!row) throw new OperationError('PROFILE_NOT_FOUND');
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: input.suspend ? 'page.suspended' : 'page.unsuspended',
        permission: 'pages.suspend',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      return { handle: row.handle };
    }),
  );
}
