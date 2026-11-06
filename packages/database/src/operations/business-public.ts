import type {
  BusinessPersonMatch,
  PagePlan,
  PublicLocation,
  PublicStaffTipPage,
  StaffCard,
  StaffPageRedirect,
} from '@tipme/contracts';
import { normaliseHandle, onShift } from '@tipme/domain';
import { and, eq, ilike, isNull, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  businesses,
  businessLocations,
  businessMembers,
  businessShifts,
  handleAliases,
  profiles,
} from '../schema.js';
import { guarded } from './errors.js';
import {
  getReadyPaymentAccount,
  type PaymentAccountEnvironment,
} from './payment-accounts.js';
import { tipAmountsOf } from './profiles.js';

// TipMe for businesses, PR B4: what a supporter sees after scanning a code. Only verified, not
// suspended businesses and open locations show anyone (M11). Only people who can take a tip right
// now are listed (M3: page live and active, and accepting tips by checkout's own rule). A card has
// the name the person chose to show and, if they allow it, their photo: nothing else of their page.

export interface PublicReadOptions {
  /** Set when new tips need the person's own account with this provider (as publicProfile). */
  requiredAccount?: {
    provider: string;
    environment: PaymentAccountEnvironment;
  };
}

/** At most this many people answer one search ("I don't see them"). */
export const BUSINESS_SEARCH_LIMIT = 20;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const slugOf = (raw: string, max: number): string | null => {
  const slug = raw.trim().toLowerCase();
  return slug.length <= max && SLUG.test(slug) ? slug : null;
};

interface RosterRow {
  memberId: string;
  profileId: string;
  handle: string;
  shownName: string;
  showPhoto: boolean;
  avatarPath: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  locationSlug: string;
  locationName: string;
}

/** Active members of a verified business's open locations whose page is live and active. */
function roster(db: Database, where: SQL | undefined): Promise<RosterRow[]> {
  return db
    .select({
      memberId: businessMembers.id,
      profileId: profiles.id,
      handle: profiles.handle,
      shownName: businessMembers.shownName,
      showPhoto: businessMembers.showPhoto,
      avatarPath: profiles.avatarPath,
      startedAt: businessShifts.startedAt,
      endedAt: businessShifts.endedAt,
      locationSlug: businessLocations.slug,
      locationName: businessLocations.name,
    })
    .from(businessMembers)
    .innerJoin(
      businessLocations,
      eq(businessLocations.id, businessMembers.locationId),
    )
    .innerJoin(businesses, eq(businesses.id, businessLocations.businessId))
    .innerJoin(profiles, eq(profiles.id, businessMembers.profileId))
    .leftJoin(
      businessShifts,
      and(
        eq(businessShifts.memberId, businessMembers.id),
        isNull(businessShifts.endedAt),
      ),
    )
    .where(
      and(
        eq(businesses.status, 'verified'),
        isNull(businessLocations.closedAt),
        isNull(businessMembers.leftAt),
        eq(profiles.pageState, 'live'),
        eq(profiles.status, 'active'),
        where,
      ),
    );
}

async function acceptingTips(
  db: Database,
  profileId: string,
  options: PublicReadOptions,
): Promise<boolean> {
  if (!options.requiredAccount) return true;
  return (
    (await getReadyPaymentAccount(db, {
      profileId,
      ...options.requiredAccount,
    })) !== null
  );
}

/** Only the people a tip can reach now, in the order given. */
async function tippable(
  db: Database,
  rows: RosterRow[],
  options: PublicReadOptions,
): Promise<RosterRow[]> {
  if (!options.requiredAccount) return rows;
  const ready = await Promise.all(
    rows.map((row) => acceptingTips(db, row.profileId, options)),
  );
  return rows.filter((_, index) => ready[index]);
}

const card = (row: RosterRow, now: Date): StaffCard => ({
  memberId: row.memberId,
  handle: row.handle,
  shownName: row.shownName,
  ...(row.showPhoto && row.avatarPath ? { avatarPath: row.avatarPath } : {}),
  onShift: onShift(
    row.startedAt ? { startedAt: row.startedAt, endedAt: row.endedAt } : null,
    now,
  ),
});

const byName = (a: { shownName: string }, b: { shownName: string }) =>
  a.shownName.localeCompare(b.shownName, 'en', { sensitivity: 'base' });

async function openLocation(
  db: Database,
  businessSlug: string,
  locationSlug: string,
): Promise<{
  businessId: string;
  business: PublicLocation['business'];
  location: PublicLocation['location'] & { id: string };
} | null> {
  const business = slugOf(businessSlug, 40);
  const location = slugOf(locationSlug, 30);
  if (!business || !location) return null;
  const [row] = await db
    .select({
      businessId: businesses.id,
      businessSlug: businesses.slug,
      businessName: businesses.name,
      locationId: businessLocations.id,
      locationSlug: businessLocations.slug,
      locationName: businessLocations.name,
    })
    .from(businessLocations)
    .innerJoin(businesses, eq(businesses.id, businessLocations.businessId))
    .where(
      and(
        eq(businesses.slug, business),
        eq(businessLocations.slug, location),
        eq(businesses.status, 'verified'),
        isNull(businessLocations.closedAt),
      ),
    );
  if (!row) return null;
  return {
    businessId: row.businessId,
    business: {
      slug: row.businessSlug,
      name: row.businessName,
      verified: true,
    },
    location: {
      id: row.locationId,
      slug: row.locationSlug,
      name: row.locationName,
    },
  };
}

/**
 * A location's page: null unless the business is verified (not suspended) and the location open.
 * People on shift come first (longest on shift first), then everyone else by name (owner item O1).
 */
export function publicLocation(
  db: Database,
  businessSlug: string,
  locationSlug: string,
  options: PublicReadOptions = {},
  now: Date = new Date(),
): Promise<PublicLocation | null> {
  return guarded(async () => {
    const place = await openLocation(db, businessSlug, locationSlug);
    if (!place) return null;
    const rows = await tippable(
      db,
      await roster(db, eq(businessLocations.id, place.location.id)),
      options,
    );
    const cards = rows.map((row) => ({ row, card: card(row, now) }));
    const on = cards
      .filter(({ card }) => card.onShift)
      .sort(
        (a, b) =>
          a.row.startedAt!.getTime() - b.row.startedAt!.getTime() ||
          byName(a.card, b.card),
      );
    const off = cards
      .filter(({ card }) => !card.onShift)
      .sort((a, b) => byName(a.card, b.card));
    return {
      business: place.business,
      location: { slug: place.location.slug, name: place.location.name },
      people: [...on, ...off].map(({ card }) => card),
    };
  });
}

/**
 * "I don't see them": people at every open location of the business whose shown name starts with
 * `q` (at least 2 characters, case ignored), at most BUSINESS_SEARCH_LIMIT. Never another business.
 */
export function searchBusinessPeople(
  db: Database,
  businessSlug: string,
  q: string,
  options: PublicReadOptions = {},
  now: Date = new Date(),
): Promise<BusinessPersonMatch[]> {
  const business = slugOf(businessSlug, 40);
  const query = q.trim();
  if (!business || Array.from(query).length < 2 || query.length > 60)
    return Promise.resolve([]);
  // LIKE's own characters are only letters here.
  const prefix = `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return guarded(async () => {
    const rows = await roster(
      db,
      and(
        eq(businesses.slug, business),
        ilike(businessMembers.shownName, prefix),
      ),
    );
    rows.sort(
      (a, b) =>
        byName(a, b) ||
        a.locationName.localeCompare(b.locationName, 'en') ||
        a.memberId.localeCompare(b.memberId),
    );
    // Checked in order and stopped at the limit: a long list never costs a lookup per person.
    const found: BusinessPersonMatch[] = [];
    for (const row of rows) {
      if (found.length >= BUSINESS_SEARCH_LIMIT) break;
      if (!(await acceptingTips(db, row.profileId, options))) continue;
      found.push({
        ...card(row, now),
        locationSlug: row.locationSlug,
        locationName: row.locationName,
      });
    }
    return found;
  });
}

/** The live, active page a handle (or an old handle of it) names. */
async function livePage(db: Database, rawHandle: string) {
  const handle = normaliseHandle(rawHandle.replace(/^@/, ''));
  if (!handle) return null;
  const live = and(
    eq(profiles.pageState, 'live'),
    eq(profiles.status, 'active'),
  );
  const [current] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.handleLower, handle), live));
  if (current) return current;
  const [renamed] = await db
    .select({ profile: profiles })
    .from(handleAliases)
    .innerJoin(profiles, eq(profiles.id, handleAliases.profileId))
    .where(and(eq(handleAliases.handleLower, handle), live));
  return renamed?.profile ?? null;
}

/**
 * A staff code's page (M2): the person's tip form at this location. A code for someone who is not
 * a member here now (they left, the business is paused, the location closed) sends them to their
 * own page, and the tip is not labelled. Null for an unknown or never-verified business, an unknown
 * location, or a page that is not live.
 */
export function publicStaffTipPage(
  db: Database,
  businessSlug: string,
  locationSlug: string,
  rawHandle: string,
  options: PublicReadOptions = {},
  now: Date = new Date(),
): Promise<PublicStaffTipPage | StaffPageRedirect | null> {
  return guarded(async () => {
    const business = slugOf(businessSlug, 40);
    const location = slugOf(locationSlug, 30);
    if (!business || !location) return null;
    // The location as it stands: it may be closed, or its business paused.
    const [place] = await db
      .select({ locationId: businessLocations.id, status: businesses.status })
      .from(businessLocations)
      .innerJoin(businesses, eq(businesses.id, businessLocations.businessId))
      .where(
        and(
          eq(businesses.slug, business),
          eq(businessLocations.slug, location),
        ),
      );
    // A business never verified has no codes in the world (M12): nothing to send anyone to.
    if (!place || place.status === 'pending') return null;
    const profile = await livePage(db, rawHandle);
    if (!profile) return null;
    const open = await openLocation(db, business, location);
    const [row] = open
      ? await roster(
          db,
          and(
            eq(businessLocations.id, open.location.id),
            eq(businessMembers.profileId, profile.id),
          ),
        )
      : [];
    if (!open || !row) return { redirectTo: `/@${profile.handle}` };
    return {
      business: open.business,
      location: { slug: open.location.slug, name: open.location.name },
      person: card(row, now),
      profile: {
        handle: profile.handle,
        displayName: profile.displayName,
        tipAmounts: tipAmountsOf(profile),
        acceptingTips: await acceptingTips(db, profile.id, options),
        plan: profile.plan as PagePlan,
      },
    };
  });
}
