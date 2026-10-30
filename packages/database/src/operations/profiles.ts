import {
  profilePatchSchema,
  type HandleStatus,
  type MyProfile,
  type NotificationPrefs,
  type OpsPage,
  type PagePlan,
  type ProfilePatch,
  type PublicProfile,
  type Socials,
  type TipAmounts,
} from '@tipme/contracts';
import {
  FEE_POLICY_V1,
  STANDARD_TIP_PRESETS_MINOR,
  isReservedHandle,
  normaliseHandle,
  tipAmountsProblem,
} from '@tipme/domain';
import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  emailTokens,
  handleAliases,
  handleHolds,
  profileAvatars,
  phoneRecoveries,
  profiles,
  sessions,
  emailCodeLockouts,
  emailCodes,
  signInCodes,
  signInLockouts,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { isOpenReleaseRun } from './release-runs.js';
import { balanceIn } from './balance.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import { publicCelebration } from './moments.js';
import {
  getReadyPaymentAccount,
  type PaymentAccountEnvironment,
} from './payment-accounts.js';

export const HANDLE_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
/** Old handles a page keeps pointing at itself (PR-011). */
export const MAX_HANDLE_ALIASES = 5;

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
  db: Database | Tx,
  handle: string,
  now: Date,
): Promise<boolean> {
  const [profile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.handleLower, handle));
  if (profile) return true;
  const [alias] = await db
    .select({ id: handleAliases.profileId })
    .from(handleAliases)
    .where(eq(handleAliases.handleLower, handle));
  if (alias) return true;
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
      .returning({ id: profiles.id })
      .catch((error: unknown) => {
        // The database refused an old handle of another page (lost a race with a rename).
        if (sqlStateOf(error) === '23505')
          throw new OperationError('HANDLE_TAKEN');
        throw error;
      });
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

/**
 * The amounts a page offers (PR-012): a Pro page's own when it has set them, otherwise the
 * standard ones. Kept on the row when a page goes back to Free, used again if it returns to Pro.
 */
export function tipAmountsOf(profile: {
  plan: string;
  tipPresetsMinor: bigint[] | null;
  minTipMinor: bigint | null;
}): TipAmounts {
  const own =
    profile.plan === 'pro' && profile.tipPresetsMinor && profile.minTipMinor;
  const presets = own
    ? profile.tipPresetsMinor!
    : [...STANDARD_TIP_PRESETS_MINOR];
  const min = own ? profile.minTipMinor! : FEE_POLICY_V1.minTipMinor;
  return {
    presetsMinor: presets.map(String),
    minMinor: String(min),
  };
}

/** A Pro page sets its own preset amounts and minimum; refused on Free (PRO_REQUIRED). */
export function setTipAmounts(
  db: Database,
  userId: string,
  input: { presetsMinor: bigint[]; minTipMinor: bigint },
): Promise<MyProfile> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    if (row.profile.plan !== 'pro') throw new OperationError('PRO_REQUIRED');
    const problem = tipAmountsProblem(input.presetsMinor, input.minTipMinor);
    if (problem === 'minMinor') throw new OperationError('INVALID_TIP_MINIMUM');
    if (problem === 'presetsMinor')
      throw new OperationError('INVALID_TIP_PRESETS');
    // Only while still Pro: staff may have moved the page to Free since it was read.
    const updated = await db
      .update(profiles)
      .set({
        tipPresetsMinor: [...input.presetsMinor].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
        minTipMinor: input.minTipMinor,
      })
      .where(and(eq(profiles.id, row.profile.id), eq(profiles.plan, 'pro')))
      .returning({ id: profiles.id });
    if (updated.length === 0) throw new OperationError('PRO_REQUIRED');
    return toMine(db, await myRow(db, userId));
  });
}

/**
 * A page as staff see it, by its handle or one of its old handles (permission `pages.plan`).
 * Deleted pages are not found.
 */
export function opsPageByHandle(
  db: Database | Tx,
  raw: string,
): Promise<OpsPage | null> {
  const handle = normaliseHandle(raw);
  if (!handle) return Promise.resolve(null);
  return guarded(async () => {
    const [current] = await db
      .select()
      .from(profiles)
      .where(
        and(
          eq(profiles.handleLower, handle),
          ne(profiles.pageState, 'deleted'),
        ),
      );
    if (current) return opsPage(current);
    const [renamed] = await db
      .select({ profile: profiles })
      .from(handleAliases)
      .innerJoin(profiles, eq(profiles.id, handleAliases.profileId))
      .where(
        and(
          eq(handleAliases.handleLower, handle),
          ne(profiles.pageState, 'deleted'),
        ),
      );
    return renamed ? opsPage(renamed.profile) : null;
  });
}

const opsPage = (row: typeof profiles.$inferSelect): OpsPage => ({
  profileId: row.id,
  handle: row.handle,
  displayName: row.displayName,
  plan: row.plan as PagePlan,
  pageState: row.pageState as OpsPage['pageState'],
  suspended: row.status === 'suspended',
});

/**
 * Staff make a page Pro or Free again (permission `pages.plan`), with a reason; audited as
 * `page.plan_pro` or `page.plan_free`. Asking for the plan it already has changes and records
 * nothing (a stale admin screen).
 */
export function setPagePlan(
  db: Database,
  input: {
    staffUserId: string;
    profileId: string;
    plan: PagePlan;
    reason: string;
  },
): Promise<OpsPage & { handleLower: string; changed: boolean }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        )
        .for('update');
      if (!current) throw new OperationError('NO_PAGE');
      if (current.plan === input.plan)
        return {
          ...opsPage(current),
          handleLower: current.handleLower,
          changed: false,
        };
      const [row] = await tx
        .update(profiles)
        .set({ plan: input.plan })
        .where(eq(profiles.id, input.profileId))
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: input.plan === 'pro' ? 'page.plan_pro' : 'page.plan_free',
        permission: 'pages.plan',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      return { ...opsPage(row!), handleLower: row!.handleLower, changed: true };
    }),
  );
}

async function previousHandles(db: Database, profileId: string) {
  const rows = await db
    .select({ handle: handleAliases.handleLower })
    .from(handleAliases)
    .where(eq(handleAliases.profileId, profileId))
    .orderBy(asc(handleAliases.createdAt));
  return rows.map((row) => row.handle);
}

const toMine = async (
  db: Database,
  row: Awaited<ReturnType<typeof myRow>>,
): Promise<MyProfile> => ({
  handle: row.profile.handle,
  previousHandles: await previousHandles(db, row.profile.id),
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
  plan: row.profile.plan as PagePlan,
  tipAmounts: tipAmountsOf(row.profile),
  avatarPath: row.profile.avatarPath,
});

export function getMyProfile(db: Database, userId: string): Promise<MyProfile> {
  return guarded(async () => toMine(db, await myRow(db, userId)));
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
    return toMine(db, await myRow(db, userId));
  });
}

export function setPageState(
  db: Database,
  userId: string,
  state: 'live' | 'not_live',
): Promise<{ handle: string; profileId: string; firstPublished: boolean }> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    // A page TipMe suspended can be taken offline but not put back live (PR-009).
    if (state === 'live' && row.profile.status === 'suspended')
      throw new OperationError('PAGE_SUSPENDED');
    // The first time a page goes live is remembered on the page itself (PR-013), so "first
    // published" stays true once ever, however long ago it was.
    const first = state === 'live' && row.profile.firstPublishedAt === null;
    const updated = await db
      .update(profiles)
      .set({
        pageState: state,
        ...(first ? { firstPublishedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(profiles.id, row.profile.id),
          ...(first ? [isNull(profiles.firstPublishedAt)] : []),
        ),
      )
      .returning({ id: profiles.id });
    return {
      handle: row.profile.handle,
      profileId: row.profile.id,
      firstPublished: first && updated.length > 0,
    };
  });
}

/**
 * Changes the page's handle (PR-011). The old one becomes an alias that keeps pointing here, so
 * printed QR codes still work; a page keeps at most 5. Going back to one of its own old handles
 * swaps the two, and a change of case alone changes nothing.
 */
export function renameHandle(
  db: Database,
  input: { userId: string; handle: string; now?: Date },
): Promise<{ previous: string; handle: string }> {
  const now = input.now ?? new Date();
  const wanted = normaliseHandle(input.handle);
  return guarded(async () => {
    if (!wanted) throw new OperationError('INVALID_INPUT');
    try {
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: profiles.id,
            handle: profiles.handle,
            handleLower: profiles.handleLower,
            pageState: profiles.pageState,
          })
          .from(profiles)
          .where(eq(profiles.userId, input.userId))
          .for('update');
        if (!row || row.pageState === 'deleted')
          throw new OperationError('NO_PAGE');
        // Handles are stored normalised (as when claimed), so a change of case is no change.
        if (wanted === row.handleLower)
          return { previous: row.handleLower, handle: wanted };
        if (isReservedHandle(wanted)) throw new OperationError('HANDLE_TAKEN');
        const reclaimed = await tx
          .delete(handleAliases)
          .where(
            and(
              eq(handleAliases.handleLower, wanted),
              eq(handleAliases.profileId, row.id),
            ),
          )
          .returning({ handle: handleAliases.handleLower });
        if (!reclaimed[0]) {
          if (await isTaken(tx, wanted, now))
            throw new OperationError('HANDLE_TAKEN');
          const [kept] = await tx
            .select({ n: count() })
            .from(handleAliases)
            .where(eq(handleAliases.profileId, row.id));
          if ((kept?.n ?? 0) >= MAX_HANDLE_ALIASES)
            throw new OperationError('HANDLE_RENAME_LIMIT');
        }
        await tx
          .insert(handleAliases)
          .values({ handleLower: row.handleLower, profileId: row.id });
        await tx
          .update(profiles)
          .set({ handle: wanted, handleLower: wanted })
          .where(eq(profiles.id, row.id));
        return { previous: row.handleLower, handle: wanted };
      });
    } catch (error) {
      // Lost a race with someone claiming the same handle at the same moment.
      if (sqlStateOf(error) === '23505')
        throw new OperationError('HANDLE_TAKEN');
      throw error;
    }
  });
}

/**
 * Where an old handle points now: the current handle of a live, active page, or null. Not-live,
 * suspended and deleted pages reveal nothing, exactly like an unknown handle.
 */
export function handleAliasTarget(
  db: Database,
  raw: string,
): Promise<string | null> {
  const handle = normaliseHandle(raw);
  if (!handle) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({ handle: profiles.handleLower })
      .from(handleAliases)
      .innerJoin(profiles, eq(profiles.id, handleAliases.profileId))
      .where(
        and(
          eq(handleAliases.handleLower, handle),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
        ),
      );
    return row?.handle ?? null;
  });
}

/** A live page's public details; null for unknown, not live, deleted and suspended pages alike. */
export function publicProfile(
  db: Database,
  raw: string,
  options: {
    /** Set when new tips need the owner's own account with this provider (the same rule checkout applies). */
    requiredAccount?: {
      provider: string;
      environment: PaymentAccountEnvironment;
    };
  } = {},
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
    const acceptingTips = options.requiredAccount
      ? (await getReadyPaymentAccount(db, {
          profileId: profile.id,
          ...options.requiredAccount,
        })) !== null
      : true;
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
      tipAmounts: tipAmountsOf(profile),
      acceptingTips,
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
        // The photo is personal data too: its bytes go with the page (PR-013).
        await tx
          .delete(profileAvatars)
          .where(eq(profileAvatars.profileId, row.id));
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
        // Old handles stop pointing at the deleted page and are held like the current one.
        const aliases = await tx
          .delete(handleAliases)
          .where(eq(handleAliases.profileId, row.id))
          .returning({ handleLower: handleAliases.handleLower });
        if (aliases.length > 0)
          await tx
            .insert(handleHolds)
            .values(
              aliases.map((alias) => ({
                handleLower: alias.handleLower,
                until: new Date(now.getTime() + HANDLE_HOLD_MS),
              })),
            )
            .onConflictDoUpdate({
              target: handleHolds.handleLower,
              set: { until: new Date(now.getTime() + HANDLE_HOLD_MS) },
            });
      }
      // Erase what identifies the person, including codes, lockouts and pending links or recoveries.
      const [person] = await tx
        .select({ phone: users.phoneE164, email: users.email })
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
      if (person?.email) {
        await tx.delete(emailCodes).where(eq(emailCodes.email, person.email));
        await tx
          .delete(emailCodeLockouts)
          .where(eq(emailCodeLockouts.email, person.email));
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

/** The recipient's notification preferences (PR-013). */
export function getNotificationPrefs(
  db: Database,
  userId: string,
): Promise<NotificationPrefs> {
  return guarded(async () => prefsOf((await myRow(db, userId)).profile));
}

export function setNotificationPrefs(
  db: Database,
  userId: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    const [updated] = await db
      .update(profiles)
      .set({
        notifyTipEmails: prefs.tipEmails,
        notifyWeeklyReports: prefs.weeklyReports,
        notifyMilestones: prefs.milestones,
      })
      .where(eq(profiles.id, row.profile.id))
      .returning();
    return prefsOf(updated!);
  });
}

const prefsOf = (profile: {
  notifyTipEmails: boolean;
  notifyWeeklyReports: boolean;
  notifyMilestones: boolean;
}): NotificationPrefs => ({
  tipEmails: profile.notifyTipEmails,
  weeklyReports: profile.notifyWeeklyReports,
  milestones: profile.notifyMilestones,
});
