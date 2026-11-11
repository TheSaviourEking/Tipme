import {
  MAX_HANDLE_CHANGE_EXTRA,
  isProQrStyle,
  shownQrStyle,
  thanksChoiceOf,
  thanksNeedsPro,
  thanksPatchSchema,
  type ThanksPatchRequest,
  MAX_HANDLE_CHANGE_GRANT,
  profilePatchSchema,
  resolveCover,
  type HandleStatus,
  type MyProfile,
  type NotificationPrefs,
  type NotificationPrefsView,
  type OpsPage,
  type PagePlan,
  type ProfilePatch,
  type PublicProfile,
  type TipAmounts,
  PRO_LINK_LIMIT,
  linksNeedPro,
  mergeFreeSave,
  isAdultPlatform,
  linkKey,
  myLinksSchema,
  visibleLinks,
  type MyLinksRequest,
} from '@tipme/contracts';
import {
  FEE_POLICY_V1,
  STANDARD_TIP_PRESETS_MINOR,
  isReservedHandle,
  normaliseHandle,
  tipAmountsProblem,
  tipStartAllowed,
} from '@tipme/domain';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  emailTokens,
  handleAliases,
  handleHolds,
  handleReservations,
  handleTakeBacks,
  profileAvatars,
  profileCovers,
  emailRecoveries,
  mailPreferences,
  phoneRecoveries,
  profiles,
  sessions,
  emailCodeLockouts,
  changelogReads,
  emailCodes,
  signInCodes,
  signInLockouts,
  supporters,
  campaigns,
  monthlyRecaps,
  supportRequests,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { isOpenReleaseRun } from './release-runs.js';
import { balanceIn } from './balance.js';
import { endBusinessRolesForDeletion } from './business-members.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import {
  isUnenrolledInvitee,
  lockedActiveStaff,
  lockStaffAdmin,
  revokeUnenrolled,
  withAuditChange,
} from './staff.js';
import { mailOwner } from './account-mail.js';
import { legacySocials } from './legacy-socials.js';
import { proStatusOf, setStaffPro } from './pro-periods.js';
import { removeObjects } from './page-images.js';
import type { MailSealing } from './mail-queue.js';
import type { PhotoStore } from '../photo-store.js';
import { newId } from './ids.js';
import {
  completeTakeBack,
  myFreeChange,
  myTakeBack,
} from './username-take-backs.js';
import { publicCelebration } from './moments.js';
import {
  getReadyPaymentAccount,
  type PaymentAccountEnvironment,
} from './payment-accounts.js';

export const HANDLE_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
/** Handle changes a Pro page gets in total, including switching back; staff can allow more. */
export const PRO_HANDLE_CHANGES = 3;

const handleChangesOf = (row: {
  handleChangesUsed: number;
  handleChangesExtra: number;
}) => ({
  used: row.handleChangesUsed,
  allowed: PRO_HANDLE_CHANGES + row.handleChangesExtra,
});

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
  return guarded(async () => {
    // A staff reservation answers exactly like a built-in word: the public never learns which list.
    if (await activeReservation(db, handle)) return 'reserved';
    return (await isTaken(db, handle, now)) ? 'taken' : 'available';
  });
}

/**
 * The active staff reservation of a name, if any. `key` is the reservationKey; a stored handle is
 * already one (handles never contain '-'), so a handle can be passed as it is.
 */
export async function activeReservation(
  db: Database | Tx,
  key: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: handleReservations.id })
    .from(handleReservations)
    .where(
      and(
        eq(handleReservations.handleLower, key),
        isNull(handleReservations.releasedAt),
      ),
    );
  return row ?? null;
}

/** A page, an old handle, a deletion hold or a staff reservation has the name. */
export async function isTaken(
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
  if (hold) return true;
  return (await activeReservation(db, handle)) !== null;
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
 * `startMinor` ("Make it yours") is sent only for a Pro page's own amounts, and only while the
 * saved start is one of the payable presets; otherwise the form starts on the closest to ₦2,000.
 */
export function tipAmountsOf(profile: {
  plan: string;
  tipPresetsMinor: bigint[] | null;
  minTipMinor: bigint | null;
  tipStartMinor?: bigint | null;
}): TipAmounts {
  const floor = FEE_POLICY_V1.minTipMinor;
  // A page can hold amounts saved under an older, lower floor: offer only what can be paid.
  const payable =
    profile.plan === 'pro' && profile.tipPresetsMinor && profile.minTipMinor
      ? profile.tipPresetsMinor.filter((amount) => amount >= floor)
      : [];
  const own = payable.length > 0;
  const presets = own ? payable : [...STANDARD_TIP_PRESETS_MINOR];
  const min =
    own && profile.minTipMinor! > floor ? profile.minTipMinor! : floor;
  const start = profile.tipStartMinor;
  return {
    presetsMinor: presets.map(String),
    minMinor: String(min),
    ...(own && start != null && tipStartAllowed(payable, start)
      ? { startMinor: String(start) }
      : {}),
  };
}

/**
 * A Pro page sets its own preset amounts and minimum, and the one its page starts on; refused on
 * Free (PRO_REQUIRED). `startMinor` null clears the start; left out, the saved start is kept while
 * it is still one of the new presets and cleared otherwise, so an older client never breaks it.
 */
export function setTipAmounts(
  db: Database,
  userId: string,
  input: {
    presetsMinor: bigint[];
    minTipMinor: bigint;
    startMinor?: bigint | null;
  },
): Promise<MyProfile> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    if (row.profile.plan !== 'pro') throw new OperationError('PRO_REQUIRED');
    const problem = tipAmountsProblem(input.presetsMinor, input.minTipMinor);
    if (problem === 'minMinor') throw new OperationError('INVALID_TIP_MINIMUM');
    if (problem === 'presetsMinor')
      throw new OperationError('INVALID_TIP_PRESETS');
    if (
      input.startMinor != null &&
      !tipStartAllowed(input.presetsMinor, input.startMinor)
    )
      throw new OperationError('INVALID_TIP_START');
    const kept = row.profile.tipStartMinor;
    const startMinor =
      input.startMinor !== undefined
        ? input.startMinor
        : kept !== null && tipStartAllowed(input.presetsMinor, kept)
          ? kept
          : null;
    // Only while still Pro: staff may have moved the page to Free since it was read.
    const updated = await db
      .update(profiles)
      .set({
        tipPresetsMinor: [...input.presetsMinor].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
        minTipMinor: input.minTipMinor,
        tipStartMinor: startMinor,
      })
      .where(and(eq(profiles.id, row.profile.id), eq(profiles.plan, 'pro')))
      .returning({ id: profiles.id });
    if (updated.length === 0) throw new OperationError('PRO_REQUIRED');
    return toMine(db, await myRow(db, userId));
  });
}

/**
 * Saves the thank-you line on the supporter's receipt. Any plan may save the line; a card style
 * other than paper, or a signature, needs Pro. Leaving `style` or `signed` out keeps what is
 * stored, so a Free save never erases a lapsed page's Pro choices.
 */
export function setThanks(
  db: Database,
  userId: string,
  patch: ThanksPatchRequest,
): Promise<MyProfile> {
  return guarded(async () => {
    const parsed = thanksPatchSchema.safeParse(patch);
    if (!parsed.success) {
      const onLine = parsed.error.issues.some(
        (issue) => issue.path[0] === 'line',
      );
      throw new OperationError(
        onLine ? 'INVALID_THANKS_LINE' : 'INVALID_INPUT',
      );
    }
    const values = parsed.data;
    const row = await myRow(db, userId);
    const needsPro = thanksNeedsPro(values);
    if (needsPro && row.profile.plan !== 'pro')
      throw new OperationError('THANKS_PRO_REQUIRED');
    // Only while still Pro when a Pro part is set: staff (or billing) may have moved the page to
    // Free since it was read.
    const updated = await db
      .update(profiles)
      .set({
        thanksLine: values.line,
        ...(values.style !== undefined ? { thanksStyle: values.style } : {}),
        ...(values.signed !== undefined ? { thanksSigned: values.signed } : {}),
      })
      .where(
        and(
          eq(profiles.id, row.profile.id),
          ...(needsPro ? [eq(profiles.plan, 'pro')] : []),
        ),
      )
      .returning({ id: profiles.id });
    if (updated.length === 0) {
      const again = await myRow(db, userId);
      if (again.profile.plan !== 'pro')
        throw new OperationError('THANKS_PRO_REQUIRED');
      return toMine(db, again);
    }
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

const opsPageWithPro = async (
  db: Database | Tx,
  row: typeof profiles.$inferSelect,
  now: Date = new Date(),
): Promise<OpsPage> => ({
  ...opsPage(row),
  ...(await proStatusOf(db, row.id, row.staffPro, now)),
});

const opsPage = (row: typeof profiles.$inferSelect): OpsPage => ({
  profileId: row.id,
  userId: row.userId,
  handle: row.handle,
  displayName: row.displayName,
  plan: row.plan as PagePlan,
  pageState: row.pageState as OpsPage['pageState'],
  suspended: row.status === 'suspended',
  handleChanges: handleChangesOf(row),
  images: {
    hasCover: row.coverPath !== null,
    hasPhoto: row.avatarPath !== null,
  },
});

/**
 * Staff make a page Pro or Free again (permission `pages.plan`), with a reason; audited as
 * `page.plan_pro` or `page.plan_free`. Asking for the grant it already has changes and records
 * nothing (a stale admin screen). This is the staff grant: a paid month keeps Pro on until its
 * grace ends, whatever staff set (ADR-0015).
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
      const now = new Date();
      // Paid Pro (ADR-0015): staff set their grant; a paid month keeps Pro on whatever it says.
      const { changed, grantChanged } = await setStaffPro(
        tx,
        input.profileId,
        input.plan === 'pro',
        now,
      );
      const [row] = await tx
        .select()
        .from(profiles)
        .where(eq(profiles.id, input.profileId));
      if (grantChanged || changed)
        await recordAudit(tx, {
          staffUserId: input.staffUserId,
          action: input.plan === 'pro' ? 'page.plan_pro' : 'page.plan_free',
          permission: 'pages.plan',
          subjectType: 'profile',
          subjectId: input.profileId,
          reason: input.reason,
        });
      return {
        ...(await opsPageWithPro(tx, row!, now)),
        handleLower: row!.handleLower,
        changed,
      };
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
  socials: legacySocials(row.profile.links),
  links: row.profile.links,
  bioPublic: row.profile.bioPublic,
  socialsPublic: row.profile.socialsPublic,
  phonePublic: row.profile.phonePublic,
  emailPublic: row.profile.emailPublic,
  pageState: row.profile.pageState as MyProfile['pageState'],
  qrStyle: shownQrStyle(row.profile.qrStyle, row.profile.plan as PagePlan),
  phone: row.phone,
  email: row.email,
  emailVerified: row.emailVerifiedAt !== null,
  suspended: row.profile.status === 'suspended',
  suspendedReason:
    row.profile.status === 'suspended' ? row.profile.suspendedReason : null,
  plan: row.profile.plan as PagePlan,
  tipAmounts: tipAmountsOf(row.profile),
  avatarPath: row.profile.avatarPath,
  cover: resolveCover(row.profile),
  coverChoice: {
    design: row.profile.coverDesign,
    colour: row.profile.coverColour,
    animation: row.profile.coverAnimation,
    motion: row.profile.coverMotion as 'once' | 'loop' | null,
    hasPhoto: row.profile.coverPath !== null,
  },
  handleChanges: handleChangesOf(row.profile),
  thanks: thanksChoiceOf({
    line: row.profile.thanksLine,
    style: row.profile.thanksStyle,
    signed: row.profile.thanksSigned,
  }),
  usernameTakeBack: await myTakeBack(db, row.profile.id),
  usernameFreeChange: await myFreeChange(db, row.profile.id),
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
    // Pro designs are saved by Pro pages only. Staff may have moved the page to Free since it
    // was read, so the update below checks the plan again.
    const proDesign =
      values.qrStyle !== undefined && isProQrStyle(values.qrStyle);
    if (proDesign && row.profile.plan !== 'pro')
      throw new OperationError('QR_DESIGN_PRO_REQUIRED');
    const updated = await db
      .update(profiles)
      .set({
        ...(values.displayName !== undefined
          ? { displayName: values.displayName }
          : {}),
        ...(values.role !== undefined ? { role: values.role || null } : {}),
        ...(values.bio !== undefined ? { bio: values.bio || null } : {}),
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
      .where(
        and(
          eq(profiles.id, row.profile.id),
          ...(proDesign ? [eq(profiles.plan, 'pro')] : []),
        ),
      )
      .returning({ id: profiles.id });
    if (updated.length === 0)
      throw new OperationError('QR_DESIGN_PRO_REQUIRED');
    return toMine(db, await myRow(db, userId));
  });
}

/**
 * The page's links (SocialLinks board, owner 5 Nov 2026), saved whole and in order. Free: up to 3
 * from Free sites, catalogue order, none featured; refused otherwise (SOCIAL_LINKS_PRO_REQUIRED).
 * A Free save replaces only the links Free shows and keeps the hidden ones a lapsed Pro page has.
 * Pro: up to 8, any order, one featured. The page row is locked for the save, so a staff plan
 * change (which locks it too) lands wholly before or after: a save that needs Pro never lands on
 * a page that has just become Free.
 */
export function setMyLinks(
  db: Database,
  userId: string,
  input: MyLinksRequest,
  /** `adultLinks: false` while ADULT_PLATFORM_LINKS is off: no new OnlyFans or Fansly links. */
  { adultLinks = true }: { adultLinks?: boolean } = {},
): Promise<MyProfile> {
  return guarded(async () => {
    const parsed = myLinksSchema.safeParse(input);
    if (!parsed.success) throw new OperationError('INVALID_INPUT');
    const { links, show, hidden } = parsed.data;
    const { profile } = await myRow(db, userId);
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ plan: profiles.plan, links: profiles.links })
        .from(profiles)
        .where(eq(profiles.id, profile.id))
        .for('update');
      if (!current) throw new OperationError('NO_PAGE');
      const pro = current.plan === 'pro';
      if (!pro && linksNeedPro(links))
        throw new OperationError('SOCIAL_LINKS_PRO_REQUIRED');
      if (pro && links.length > PRO_LINK_LIMIT)
        throw new OperationError('INVALID_INPUT');
      // Switched off, adult-platform links already stored may stay (they don't show); new ones
      // can't be added.
      if (!adultLinks) {
        const stored = new Set(current.links.map((link) => linkKey(link.url)));
        if (
          links.some(
            (link) =>
              isAdultPlatform(link.platform) && !stored.has(linkKey(link.url)),
          )
        )
          throw new OperationError('SOCIAL_LINK_UNAVAILABLE');
      }
      const saved = pro ? links : mergeFreeSave(current.links, links, hidden);
      await tx
        .update(profiles)
        .set({
          links: saved,
          // The old column follows what shows, so an API from before social links (a rollback,
          // or the old colour during a deploy) shows the truth and never a hidden link.
          // TODO(social-links): stop writing it in the release that drops the column.
          socials: legacySocials(
            visibleLinks(saved, current.plan as PagePlan, {
              adult: adultLinks,
            }),
          ),
          socialsPublic: show,
        })
        .where(
          and(eq(profiles.id, profile.id), eq(profiles.plan, current.plan)),
        );
    });
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
 * Changes the page's handle. Only a Pro page can, PRO_HANDLE_CHANGES times in total plus what staff
 * allowed; the count never resets and is checked under the row lock, so two changes at once can't
 * both take the last one. The old handle becomes an alias that keeps pointing here, so printed QR
 * codes still work. Going back to one of its own old handles swaps the two, and counts. A change of
 * case alone changes nothing and counts nothing.
 *
 * While TipMe is taking the current handle back, any change (the take-back form or an ordinary one)
 * completes the take-back instead: any plan, not counted, and no alias for the taken name, whose
 * links stop working. An old handle under a take-back can't be switched back to.
 */
export function renameHandle(
  db: Database,
  input: { userId: string; handle: string; now?: Date; sealing?: MailSealing },
): Promise<{ previous: string; handle: string; takeBack?: true }> {
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
            plan: profiles.plan,
            handleChangesUsed: profiles.handleChangesUsed,
            handleChangesExtra: profiles.handleChangesExtra,
          })
          .from(profiles)
          .where(eq(profiles.userId, input.userId))
          .for('update');
        if (!row || row.pageState === 'deleted')
          throw new OperationError('NO_PAGE');
        // Handles are stored normalised (as when claimed), so a change of case is no change.
        if (wanted === row.handleLower)
          return { previous: row.handleLower, handle: wanted };
        // After the profile lock, as everywhere: then the take-back row.
        const [takeBack] = await tx
          .select({ id: handleTakeBacks.id })
          .from(handleTakeBacks)
          .where(
            and(
              eq(handleTakeBacks.profileId, row.id),
              eq(handleTakeBacks.kind, 'current'),
              inArray(handleTakeBacks.state, ['approved', 'noticed', 'due']),
            ),
          )
          .for('update');
        // After TipMe assigned a username: one change, any plan, not counted (owner answer 4).
        const [freeChange] = takeBack
          ? []
          : await tx
              .select({ id: handleTakeBacks.id })
              .from(handleTakeBacks)
              .where(
                and(
                  eq(handleTakeBacks.profileId, row.id),
                  eq(handleTakeBacks.state, 'done'),
                  isNull(handleTakeBacks.freeChangeUsedAt),
                  gt(handleTakeBacks.freeChangeUntil, now),
                ),
              )
              .orderBy(desc(handleTakeBacks.doneAt))
              .limit(1)
              .for('update');
        const { used, allowed } = handleChangesOf(row);
        if (!takeBack && !freeChange) {
          if (row.plan !== 'pro')
            throw new OperationError('HANDLE_CHANGE_PRO_REQUIRED');
          if (used >= allowed) throw new OperationError('HANDLE_CHANGE_LIMIT');
        }
        // An old handle TipMe is taking back is not this page's to return to.
        const [oldTakenBack] = await tx
          .select({ id: handleTakeBacks.id })
          .from(handleTakeBacks)
          .where(
            and(
              eq(handleTakeBacks.profileId, row.id),
              eq(handleTakeBacks.handleLower, wanted),
              inArray(handleTakeBacks.state, ['approved', 'noticed', 'due']),
            ),
          );
        if (oldTakenBack) throw new OperationError('HANDLE_TAKEN');
        // A reserved name is refused unless it is this page's own old handle: someone who
        // renamed away from a name that was later reserved can come back to it.
        const reclaimed = await tx
          .delete(handleAliases)
          .where(
            and(
              eq(handleAliases.handleLower, wanted),
              eq(handleAliases.profileId, row.id),
            ),
          )
          .returning({ handle: handleAliases.handleLower });
        if (
          !reclaimed[0] &&
          (isReservedHandle(wanted) || (await isTaken(tx, wanted, now)))
        )
          throw new OperationError('HANDLE_TAKEN');
        if (takeBack) {
          if (!input.sealing) throw new OperationError('INVALID_INPUT');
          await completeTakeBack(tx, {
            takeBackId: takeBack.id,
            outcome: 'user_chose',
            chosenHandle: wanted,
            sealing: input.sealing,
            now,
            actorUserId: input.userId,
          });
          return { previous: row.handleLower, handle: wanted, takeBack: true };
        }
        await tx
          .insert(handleAliases)
          .values({ handleLower: row.handleLower, profileId: row.id });
        await tx
          .update(profiles)
          .set({
            handle: wanted,
            handleLower: wanted,
            handleChangesUsed: freeChange ? used : used + 1,
          })
          .where(eq(profiles.id, row.id));
        if (freeChange) {
          await tx
            .update(handleTakeBacks)
            .set({ freeChangeUsedAt: now })
            .where(eq(handleTakeBacks.id, freeChange.id));
          await recordAudit(tx, {
            staffUserId: input.userId,
            action: 'username.free_change_used',
            subjectType: 'profile',
            subjectId: row.id,
            reason: withAuditChange(
              'The free change after an assigned username',
              {
                takeBackId: freeChange.id,
                from: row.handleLower,
                to: wanted,
              },
            ),
            now,
          });
        }
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
 * Staff allow a page more handle changes (permission `pages.plan`), with a reason; audited as
 * `page.handle_changes_granted`. Adds to what it has, up to MAX_HANDLE_CHANGE_EXTRA in total; beyond
 * that nothing changes (INVALID_INPUT). `handle` may be one of its old handles, as in the Pages
 * lookup. It is an allowance only: a Free page still can't change its handle.
 */
export function grantHandleChanges(
  db: Database,
  input: { staffId: string; handle: string; extra: number; reason: string },
): Promise<{ allowed: number }> {
  const { extra } = input;
  if (!Number.isInteger(extra) || extra < 1 || extra > MAX_HANDLE_CHANGE_GRANT)
    return Promise.reject(new OperationError('INVALID_INPUT'));
  return guarded(async () => {
    const page = await opsPageByHandle(db, input.handle);
    if (!page) throw new OperationError('NO_PAGE');
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(profiles)
        .set({
          handleChangesExtra: sql`${profiles.handleChangesExtra} + ${extra}`,
        })
        .where(
          and(
            eq(profiles.id, page.profileId),
            ne(profiles.pageState, 'deleted'),
            lte(profiles.handleChangesExtra, MAX_HANDLE_CHANGE_EXTRA - extra),
          ),
        )
        .returning();
      // The page was there a moment ago, so this is the cap (a page deleted in that moment is
      // refused all the same).
      if (!row) throw new OperationError('INVALID_INPUT');
      const { allowed } = handleChangesOf(row);
      await recordAudit(tx, {
        staffUserId: input.staffId,
        action: 'page.handle_changes_granted',
        permission: 'pages.plan',
        subjectType: 'profile',
        subjectId: row.id,
        // The audit row has no field for the number, and it must say how many were allowed.
        reason: `${input.reason} (+${extra}, ${allowed} allowed)`,
      });
      return { allowed };
    });
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
    /** False while ADULT_PLATFORM_LINKS is off: OnlyFans and Fansly links don't show. */
    adultLinks?: boolean;
    /** True while SUPPORTER_RECOGNITION is on: a Pro page then offers the recognition tick box. */
    recognition?: boolean;
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
    const links = visibleLinks(profile.links, profile.plan as PagePlan, {
      adult: options.adultLinks ?? true,
    });
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
      ...(profile.socialsPublic && links.length > 0 ? { links } : {}),
      ...(profile.phonePublic && row.phone ? { phone: row.phone } : {}),
      ...(profile.emailPublic && row.email && row.emailVerifiedAt
        ? { email: row.email }
        : {}),
      ...(celebration ? { celebration } : {}),
      tipAmounts: tipAmountsOf(profile),
      acceptingTips,
      cover: resolveCover(profile),
      plan: profile.plan as PagePlan,
      ...(options.recognition === true && profile.plan === 'pro'
        ? { recognition: true as const }
        : {}),
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
  input: {
    userId: string;
    sealing: MailSealing;
    /** Where photos live when not in Postgres: their objects go with the account. */
    photos?: PhotoStore;
    now?: Date;
    /**
     * The release-check sweep only: the account must be a tagged rehearsal. Its test money
     * doesn't block deletion (nothing is unbooked), and nobody is emailed.
     */
    rehearsalCleanup?: boolean;
  },
): Promise<{ handle: string }> {
  const now = input.now ?? new Date();
  const photoKeys: string[] = [];
  return guarded(async () => {
    const result = await db.transaction(async (tx) => {
      // Locks in one order, so nothing here can deadlock: the staff-admin lock (no invitation while
      // this runs), recovery rows (as addStaff and completing a recovery), the page (as anything
      // that mails its owner), then the account. Writing anything naming the account takes a share
      // of its row, so all of this comes before the first such write.
      await lockStaffAdmin(tx);
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
      // Deleted, not cancelled: each row holds an address, and it must not move back later.
      await tx
        .delete(emailRecoveries)
        .where(eq(emailRecoveries.userId, input.userId));
      const [row] = await tx
        .select({
          id: profiles.id,
          handleLower: profiles.handleLower,
          pageState: profiles.pageState,
          rehearsalRunId: profiles.rehearsalRunId,
        })
        .from(profiles)
        .where(eq(profiles.userId, input.userId))
        .for('update');
      if (input.rehearsalCleanup && !row?.rehearsalRunId)
        throw new OperationError('INVALID_INPUT');
      // TipMe for businesses (M13): refused while the person is a verified business's only owner;
      // otherwise their memberships, shifts and manager seats end here, with the account.
      await endBusinessRolesForDeletion(tx, input.userId, now);
      // Someone who has ever enrolled needs removing by someone else first, even mid-reset. A mere
      // invitee never had the use of it, and an invitation mustn't cost them their account.
      if (
        (await lockedActiveStaff(tx, input.userId)) &&
        !input.rehearsalCleanup
      ) {
        if (!(await isUnenrolledInvitee(tx, input.userId)))
          throw new OperationError('STAFF_CANNOT_DELETE');
        await revokeUnenrolled(tx, {
          userId: input.userId,
          via: 'account_deleted',
          sealing: input.sealing,
          now,
        });
      }
      if (row && row.pageState !== 'deleted') {
        const balance = await balanceIn(tx, row.id);
        if (
          !input.rehearsalCleanup &&
          (balance.availableMinor > 0n || balance.confirmingMinor > 0n)
        )
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
            coverDesign: null,
            coverColour: null,
            coverAnimation: null,
            coverMotion: null,
            coverPath: null,
            socials: {},
            links: [],
            phonePublic: false,
            emailPublic: false,
            thanksLine: null,
            thanksStyle: null,
            thanksSigned: false,
          })
          .where(eq(profiles.id, row.id));
        // Opted-in supporters of this page go with it (their tip links cascade); the tips stay.
        await tx.delete(supporters).where(eq(supporters.profileId, row.id));
        // Pro insights: campaign names, recaps and support words are the person's own; the tips stay.
        await tx.execute(
          sql`DELETE FROM tip_campaigns WHERE campaign_id IN (SELECT id FROM campaigns WHERE profile_id = ${row.id})`,
        );
        await tx.delete(campaigns).where(eq(campaigns.profileId, row.id));
        await tx
          .delete(monthlyRecaps)
          .where(eq(monthlyRecaps.profileId, row.id));
        await tx
          .delete(supportRequests)
          .where(eq(supportRequests.userId, input.userId));
        // The photo is personal data too: its bytes go with the page (PR-013).
        await tx
          .delete(profileAvatars)
          .where(eq(profileAvatars.profileId, row.id))
          .returning({ objectKey: profileAvatars.objectKey })
          .then((removed) => {
            for (const r of removed)
              if (r.objectKey) photoKeys.push(r.objectKey);
          });
        await tx
          .delete(profileCovers)
          .where(eq(profileCovers.profileId, row.id))
          .returning({ objectKey: profileCovers.objectKey })
          .then((removed) => {
            for (const r of removed)
              if (r.objectKey) photoKeys.push(r.objectKey);
          });
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
        // A take-back under way ends here: the page has left the name, so it is reserved for good
        // (the hold stays too). No done email: the account is going.
        const open = await tx
          .select({ id: handleTakeBacks.id })
          .from(handleTakeBacks)
          .where(
            and(
              eq(handleTakeBacks.profileId, row.id),
              inArray(handleTakeBacks.state, ['approved', 'noticed', 'due']),
            ),
          );
        for (const takeBack of open)
          await completeTakeBack(tx, {
            takeBackId: takeBack.id,
            outcome: 'page_deleted',
            sealing: input.sealing,
            now,
            actorUserId: input.userId,
          });
      }
      // Erase what identifies the person, including codes, lockouts and pending links.
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
      // Before the address goes: this is the last email the account gets (rehearsals get none).
      if (!input.rehearsalCleanup)
        await mailOwner(tx, input.sealing, {
          userId: input.userId,
          type: 'account_deleted_notice',
          data: {},
          dedupeKey: `account_deleted_notice.${input.userId}`,
          now,
        });
      await tx
        .update(users)
        .set({
          phoneE164: null,
          recoveryEmail: null,
          recoveryEmailVerifiedAt: null,
          email: null,
          emailVerifiedAt: null,
          deletedAt: now,
        })
        .where(eq(users.id, input.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(eq(sessions.userId, input.userId));
      // When they last opened What's new: per person, so it goes with the account. Its foreign key
      // to users doesn't cascade (the users row stays, erased), so it is removed here.
      await tx
        .delete(changelogReads)
        .where(eq(changelogReads.userId, input.userId));
      return { handle: row?.handleLower ?? '' };
    });
    // After the commit: an account's photos must not outlive it in the bucket.
    await removeObjects(input.photos, photoKeys);
    return result;
  });
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
    sealing: MailSealing;
  },
): Promise<{ handle: string }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [before] = await tx
        .select({ status: profiles.status })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
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
      // Staff notes stay private: the email says what happened, not why. Only a real change is
      // news: restoring a page that was never paused, or pausing twice, sends nothing.
      const type = input.suspend ? 'page_paused' : 'page_restored';
      const changed = (before?.status === 'suspended') !== input.suspend;
      if (changed)
        await mailOwner(tx, input.sealing, {
          profileId: input.profileId,
          type,
          data: {},
          // Each action is news, even back and forth in the same minute.
          dedupeKey: `${type}.${input.profileId}.${newId()}`,
        });
      return { handle: row.handle };
    }),
  );
}

/** The recipient's notification preferences (PR-013), and the guides email switch. */
export function getNotificationPrefs(
  db: Database,
  userId: string,
): Promise<NotificationPrefsView> {
  return guarded(async () =>
    prefsOf((await myRow(db, userId)).profile, await guidesOn(db, userId)),
  );
}

export function setNotificationPrefs(
  db: Database,
  userId: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefsView> {
  return guarded(async () => {
    const row = await myRow(db, userId);
    const [updated] = await db
      .update(profiles)
      .set({
        notifyTipEmails: prefs.tipEmails,
        notifyWeeklyReports: prefs.weeklyReports,
        notifyMilestones: prefs.milestones,
        // Set only when sent: an older client that doesn't know them leaves them as they are.
        ...(prefs.hideTipDetailsInPopups === undefined
          ? {}
          : { popupHideTipDetails: prefs.hideTipDetailsInPopups }),
        ...(prefs.tipSound === undefined ? {} : { tipSound: prefs.tipSound }),
      })
      .where(eq(profiles.id, row.profile.id))
      .returning();
    await db
      .insert(mailPreferences)
      .values({ userId, engagement: prefs.guideEmails })
      .onConflictDoUpdate({
        target: mailPreferences.userId,
        set: { engagement: prefs.guideEmails, updatedAt: new Date() },
      });
    return prefsOf(updated!, prefs.guideEmails);
  });
}

async function guidesOn(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: mailPreferences.engagement })
    .from(mailPreferences)
    .where(eq(mailPreferences.userId, userId));
  return row?.on ?? true;
}

const prefsOf = (
  profile: {
    notifyTipEmails: boolean;
    notifyWeeklyReports: boolean;
    notifyMilestones: boolean;
    popupHideTipDetails: boolean;
    tipSound: boolean;
  },
  guideEmails: boolean,
): NotificationPrefsView => ({
  tipEmails: profile.notifyTipEmails,
  weeklyReports: profile.notifyWeeklyReports,
  milestones: profile.notifyMilestones,
  guideEmails,
  hideTipDetailsInPopups: profile.popupHideTipDetails,
  tipSound: profile.tipSound,
});

/**
 * Paid Pro (ADR-0015): why a page is Pro, and until when it is paid. Billing details, so only for
 * staff who change plans (`pages.plan`); the page lookup itself stays public-level.
 */
export async function opsPageProStatus(
  db: Database | Tx,
  profileId: string,
): Promise<Required<Pick<OpsPage, 'proSource' | 'paidUntil' | 'graceUntil'>>> {
  const [page] = await db
    .select({ staffPro: profiles.staffPro })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return proStatusOf(db, profileId, page?.staffPro ?? false);
}
