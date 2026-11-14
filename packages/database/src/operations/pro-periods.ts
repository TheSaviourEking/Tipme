import { visibleLinks, type PagePlan } from '@tipme/contracts';
import {
  type BusinessPlan,
  lagosDateWords,
  nextPeriodStart,
  proGraceEnd,
  proPeriodEnd,
} from '@tipme/domain';
import { and, asc, desc, eq, gt, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { businesses, proPeriods, profiles, PRO_PAID_BY } from '../schema.js';
import { mailOwner } from './account-mail.js';
import { type MoneyOwner, ownerColumns, personOf } from './owner.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { legacySocials } from './legacy-socials.js';
import type { MailSealing } from './mail-queue.js';
import { currentProPrice } from './pro-price.js';

/*
 * Paid Pro periods (ADR-0015). `profiles.plan` stays the one field every Pro check reads; this
 * module is the only place it is derived: Pro while staff granted it, or while a paid month covers
 * now (its grace included). Every function here takes the profile row's lock first, so a staff
 * change, a confirmation and the expiry sweep land one after another.
 */

export type ProPaidBy = (typeof PRO_PAID_BY)[number];
export type ProPeriodStatus = 'SCHEDULED' | 'ACTIVE' | 'GRACE' | 'ENDED';

const DAY_MS = 86_400_000;

async function lockProfile(tx: Tx, profileId: string) {
  const [row] = await tx
    .select({
      id: profiles.id,
      plan: profiles.plan,
      staffPro: profiles.staffPro,
      links: profiles.links,
      handleLower: profiles.handleLower,
    })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for('update');
  if (!row) throw new OperationError('PROFILE_NOT_FOUND');
  return row;
}

/** Whether a paid month (grace included) covers `now`. */
async function paidCovers(
  tx: Tx | Database,
  profileId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: proPeriods.id })
    .from(proPeriods)
    .where(
      and(
        eq(proPeriods.profileId, profileId),
        lte(proPeriods.startsAt, now),
        gt(proPeriods.graceEndsAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Rewrites `profiles.plan` from the staff grant and the paid months, under the profile lock. When
 * it changes, the legacy `socials` column follows what the plan shows, as a staff change does.
 */
export async function recomputePlan(
  tx: Tx,
  profileId: string,
  now: Date,
): Promise<{ plan: PagePlan; changed: boolean; handleLower: string }> {
  const page = await lockProfile(tx, profileId);
  const plan: PagePlan =
    page.staffPro || (await paidCovers(tx, profileId, now)) ? 'pro' : 'free';
  if (plan === page.plan)
    return { plan, changed: false, handleLower: page.handleLower };
  await tx
    .update(profiles)
    .set({
      plan,
      // TODO(social-links): stop writing it in the release that drops the column.
      socials: legacySocials(visibleLinks(page.links, plan)),
    })
    .where(eq(profiles.id, profileId));
  return { plan, changed: true, handleLower: page.handleLower };
}

/** Sets the staff grant (setPagePlan's half), then the plan. */
export async function setStaffPro(
  tx: Tx,
  profileId: string,
  staffPro: boolean,
  now: Date,
): Promise<{ plan: PagePlan; changed: boolean; grantChanged: boolean }> {
  const page = await lockProfile(tx, profileId);
  const grantChanged = page.staffPro !== staffPro;
  if (grantChanged)
    await tx
      .update(profiles)
      .set({ staffPro })
      .where(eq(profiles.id, profileId));
  const { plan, changed } = await recomputePlan(tx, profileId, now);
  return { plan, changed, grantChanged };
}

type PeriodRow = typeof proPeriods.$inferSelect;
const asStarted = (row: PeriodRow) => ({
  periodId: row.id,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status as 'ACTIVE' | 'SCHEDULED',
});

/** Whose months these are: a page's or a business's (Business Pro). */
type PeriodSubject = MoneyOwner;
const subjectColumn = (subject: PeriodSubject) =>
  'businessId' in subject
    ? eq(proPeriods.businessId, subject.businessId)
    : eq(proPeriods.profileId, subject.profileId);

/**
 * The shared half of starting a paid month, for a page or a business, under the caller's lock on
 * that subject. The same `purchaseId` again returns the month it started (`already`).
 */
async function startPeriodFor(
  tx: Tx,
  subject: PeriodSubject,
  input: {
    purchaseId: string;
    paidBy: ProPaidBy;
    amountMinor: bigint;
    currency: 'NGN';
    now: Date;
  },
): Promise<ReturnType<typeof asStarted> & { already: boolean }> {
  const [already] = await tx
    .select()
    .from(proPeriods)
    .where(eq(proPeriods.purchaseId, input.purchaseId));
  if (already) return { ...asStarted(already), already: true };
  const [queued] = await tx
    .select({ id: proPeriods.id })
    .from(proPeriods)
    .where(and(subjectColumn(subject), eq(proPeriods.status, 'SCHEDULED')));
  if (queued) throw new OperationError('PRO_ALREADY_RENEWED');
  const [latest] = await tx
    .select()
    .from(proPeriods)
    .where(subjectColumn(subject))
    .orderBy(desc(proPeriods.endsAt))
    .limit(1);
  const startsAt = nextPeriodStart(input.now, latest ?? null);
  const endsAt = proPeriodEnd(startsAt);
  const status =
    startsAt.getTime() > input.now.getTime() ? 'SCHEDULED' : 'ACTIVE';
  // Paid during grace: the old month is over, this one takes over from its end.
  if (status === 'ACTIVE' && latest && latest.status !== 'ENDED')
    await tx
      .update(proPeriods)
      .set({ status: 'ENDED' })
      .where(eq(proPeriods.id, latest.id));
  const id = newId();
  await tx.insert(proPeriods).values({
    id,
    ...ownerColumns(subject),
    purchaseId: input.purchaseId,
    startsAt,
    endsAt,
    graceEndsAt: proGraceEnd(endsAt),
    status,
    paidBy: input.paidBy,
    amountMinor: input.amountMinor,
    currency: input.currency,
    createdAt: input.now,
  });
  return { periodId: id, startsAt, endsAt, status, already: false };
}

/**
 * Starts the month one confirmed payment bought, exactly once: the same `purchaseId` again returns
 * the month it started. While a month runs or is in grace, the new one starts at its end (queued
 * when that is later than now); after grace, now. At most one month is queued: another is refused
 * PRO_ALREADY_RENEWED. The plan is recomputed in the same transaction.
 */
export async function startPaidPeriod(
  tx: Tx,
  input: {
    profileId: string;
    purchaseId: string;
    paidBy: ProPaidBy;
    amountMinor: bigint;
    currency: 'NGN';
    now: Date;
  },
): Promise<{
  periodId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'ACTIVE' | 'SCHEDULED';
  planChanged: boolean;
  handleLower: string;
}> {
  const page = await lockProfile(tx, input.profileId);
  const { already, ...started } = await startPeriodFor(
    tx,
    { profileId: input.profileId },
    input,
  );
  if (already)
    return { ...started, planChanged: false, handleLower: page.handleLower };
  const { changed } = await recomputePlan(tx, input.profileId, input.now);
  return { ...started, planChanged: changed, handleLower: page.handleLower };
}

// ---- Business Pro (plan Task A3): a business's months. Never takes a profile lock. ----

async function lockBusiness(tx: Tx, businessId: string) {
  const [row] = await tx
    .select({
      id: businesses.id,
      slug: businesses.slug,
      plan: businesses.plan,
      proLapsedAt: businesses.proLapsedAt,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .for('update');
  if (!row) throw new OperationError('BUSINESS_NOT_FOUND');
  return row;
}

/**
 * Rewrites `businesses.plan` from the business's paid months, under the business lock: pro while a
 * paid month covers now (grace included). Pro to free stamps `pro_lapsed_at`; free to pro clears it.
 * A business's Pro never touches its owners' own pages.
 */
export async function recomputeBusinessPlan(
  tx: Tx,
  businessId: string,
  now: Date,
): Promise<{ plan: BusinessPlan; changed: boolean; slug: string }> {
  const business = await lockBusiness(tx, businessId);
  const [covering] = await tx
    .select({ id: proPeriods.id })
    .from(proPeriods)
    .where(
      and(
        eq(proPeriods.businessId, businessId),
        lte(proPeriods.startsAt, now),
        gt(proPeriods.graceEndsAt, now),
      ),
    )
    .limit(1);
  const plan: BusinessPlan = covering ? 'pro' : 'free';
  if (plan === business.plan)
    return { plan, changed: false, slug: business.slug };
  await tx
    .update(businesses)
    .set({ plan, proLapsedAt: plan === 'free' ? now : null })
    .where(eq(businesses.id, businessId));
  return { plan, changed: true, slug: business.slug };
}

/** startPaidPeriod for a business: the same rules, under the business lock. */
export async function startBusinessPaidPeriod(
  tx: Tx,
  input: {
    businessId: string;
    purchaseId: string;
    paidBy: ProPaidBy;
    amountMinor: bigint;
    currency: 'NGN';
    now: Date;
  },
): Promise<{
  periodId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'ACTIVE' | 'SCHEDULED';
  planChanged: boolean;
  slug: string;
}> {
  const business = await lockBusiness(tx, input.businessId);
  const { already, ...started } = await startPeriodFor(
    tx,
    { businessId: input.businessId },
    input,
  );
  if (already) return { ...started, planChanged: false, slug: business.slug };
  const { changed } = await recomputeBusinessPlan(
    tx,
    input.businessId,
    input.now,
  );
  return { ...started, planChanged: changed, slug: business.slug };
}

/** Moves one subject's months on with the clock; returns how many rows moved. */
async function moveMonths(
  tx: Tx,
  subject: PeriodSubject,
  now: Date,
  hooks: {
    graceStarted?: (row: PeriodRow) => Promise<void>;
    ended?: (row: PeriodRow) => Promise<void>;
  },
): Promise<number> {
  const rows = await tx
    .select()
    .from(proPeriods)
    .where(and(subjectColumn(subject), ne(proPeriods.status, 'ENDED')))
    .orderBy(asc(proPeriods.startsAt));
  let count = 0;
  const set = async (row: PeriodRow, status: ProPeriodStatus) => {
    await tx
      .update(proPeriods)
      .set({ status })
      .where(eq(proPeriods.id, row.id));
    row.status = status;
    count += 1;
  };
  // A queued month takes over from the one before it, with no grace in between.
  for (const row of rows)
    if (row.status === 'SCHEDULED' && row.startsAt <= now) {
      for (const before of rows)
        if (
          before !== row &&
          before.startsAt < row.startsAt &&
          before.status !== 'ENDED'
        )
          await set(before, 'ENDED');
      await set(row, 'ACTIVE');
    }
  for (const row of rows) {
    if (row.status === 'ACTIVE' && row.endsAt <= now) {
      await set(row, 'GRACE');
      if (row.graceEndsAt > now) await hooks.graceStarted?.(row);
    }
    if (row.status === 'GRACE' && row.graceEndsAt <= now) {
      await set(row, 'ENDED');
      await hooks.ended?.(row);
    }
  }
  return count;
}

/** What staff see about a page's Pro: who gave it, and until when it is paid. */
export async function proStatusOf(
  db: Database | Tx,
  profileId: string,
  staffPro: boolean,
  now: Date = new Date(),
): Promise<{
  proSource: 'staff' | 'paid' | null;
  paidUntil: string | null;
  graceUntil: string | null;
}> {
  const [latest] = await db
    .select({ endsAt: proPeriods.endsAt, graceEndsAt: proPeriods.graceEndsAt })
    .from(proPeriods)
    .where(
      and(eq(proPeriods.profileId, profileId), gt(proPeriods.graceEndsAt, now)),
    )
    .orderBy(desc(proPeriods.endsAt))
    .limit(1);
  return {
    proSource: staffPro ? 'staff' : latest ? 'paid' : null,
    paidUntil: latest ? latest.endsAt.toISOString() : null,
    graceUntil: latest ? latest.graceEndsAt.toISOString() : null,
  };
}

/** A page whose plan changed, for the caller to revalidate and signal after commit. */
export interface ProPlanChange {
  profileId: string;
  handleLower: string;
  plan: PagePlan;
}

/** A business whose plan changed (Business Pro), for the caller to signal after commit. */
export interface BusinessPlanChange {
  businessId: string;
  slug: string;
  plan: BusinessPlan;
}

const DUE = (now: Date) =>
  sql`((${proPeriods.status} = 'SCHEDULED' AND ${proPeriods.startsAt} <= ${now})
        OR (${proPeriods.status} = 'ACTIVE' AND ${proPeriods.endsAt} <= ${now})
        OR (${proPeriods.status} = 'GRACE' AND ${proPeriods.graceEndsAt} <= ${now}))`;

/**
 * The expiry sweep (every minute): queued months whose start has come become ACTIVE, months whose
 * end has come go into GRACE ("grace started" once), and months whose grace has ended are ENDED
 * ("Pro ended" once, unless something else still keeps Pro on). One profile per transaction, under
 * its lock, so a confirmation racing it lands wholly before or after. Business months (Business
 * Pro) are swept the same way, one business per transaction under the business lock; their
 * notices come with Phase B's mail.
 */
export async function expireDuePeriods(
  db: Database,
  input: { now: Date; sealing: MailSealing; limit?: number },
): Promise<{
  changed: ProPlanChange[];
  businessChanges: BusinessPlanChange[];
  moved: number;
}> {
  const { now } = input;
  const due = await db
    .selectDistinct({ profileId: proPeriods.profileId })
    .from(proPeriods)
    .where(sql`${proPeriods.profileId} IS NOT NULL AND ${DUE(now)}`)
    .limit(input.limit ?? 200);
  const changed: ProPlanChange[] = [];
  let moved = 0;
  for (const { profileId: pageId } of due) {
    const profileId = personOf(pageId);
    const result = await guarded(() =>
      db.transaction(async (tx) => {
        const before = await lockProfile(tx, profileId);
        const count = await moveMonths(tx, { profileId }, now, {
          graceStarted: async (row) => {
            await mailOwner(tx, input.sealing, {
              profileId,
              type: 'pro_grace_started',
              data: { graceEndDate: lagosDateWords(row.graceEndsAt) },
              dedupeKey: `pro_grace_started.${row.id}`,
              now,
            });
          },
          ended: async (row) => {
            const plan = await recomputePlan(tx, profileId, now);
            if (plan.plan === 'free')
              await mailOwner(tx, input.sealing, {
                profileId,
                type: 'pro_ended',
                data: {},
                dedupeKey: `pro_ended.${row.id}`,
                now,
              });
          },
        });
        const plan = await recomputePlan(tx, profileId, now);
        return {
          change:
            plan.plan === before.plan
              ? null
              : { profileId, handleLower: plan.handleLower, plan: plan.plan },
          count,
        };
      }),
    );
    moved += result.count;
    if (result.change) changed.push(result.change);
  }
  const dueBusinesses = await db
    .selectDistinct({ businessId: proPeriods.businessId })
    .from(proPeriods)
    .where(sql`${proPeriods.businessId} IS NOT NULL AND ${DUE(now)}`)
    .limit(input.limit ?? 200);
  const businessChanges: BusinessPlanChange[] = [];
  for (const { businessId } of dueBusinesses) {
    if (businessId === null) continue;
    const result = await guarded(() =>
      db.transaction(async (tx) => {
        const before = await lockBusiness(tx, businessId);
        const count = await moveMonths(tx, { businessId }, now, {});
        const plan = await recomputeBusinessPlan(tx, businessId, now);
        return {
          change:
            plan.plan === before.plan
              ? null
              : { businessId, slug: plan.slug, plan: plan.plan },
          count,
        };
      }),
    );
    moved += result.count;
    if (result.change) businessChanges.push(result.change);
  }
  return { changed, businessChanges, moved };
}

/**
 * Renewal reminders (every 15 minutes): 7 days and 1 day before a month ends, once each per month
 * (deduplicated mail keys), and none while the next month is already queued. The price in the
 * email is the server's current price for a new month.
 */
export async function sendProReminders(
  db: Database,
  input: {
    now: Date;
    sealing: MailSealing;
    /**
     * PRO_AUTO_RENEW is on (plan Task 10): a month that renews itself on a saved card gets no
     * reminder, unless its renewal was refused, when the reminders go as usual.
     */
    autoRenewOn?: boolean;
  },
): Promise<{ queued: number }> {
  const { now } = input;
  const horizon = new Date(now.getTime() + 7 * DAY_MS);
  const rows = await db
    .select()
    .from(proPeriods)
    .where(
      and(
        // A business's months have their own reminders (Business Pro, Phase B).
        isNotNull(proPeriods.profileId),
        eq(proPeriods.status, 'ACTIVE'),
        gt(proPeriods.endsAt, now),
        lte(proPeriods.endsAt, horizon),
        sql`NOT EXISTS (SELECT 1 FROM pro_periods queued
               WHERE queued.profile_id = ${proPeriods.profileId} AND queued.status = 'SCHEDULED')`,
        input.autoRenewOn
          ? sql`NOT EXISTS (SELECT 1 FROM pro_auto_renew renew
               WHERE renew.profile_id = ${proPeriods.profileId} AND renew.enabled
                 AND renew.payment_method_reference IS NOT NULL
                 AND renew.failed_period_id IS DISTINCT FROM ${proPeriods.id})`
          : sql`true`,
      ),
    );
  if (rows.length === 0) return { queued: 0 };
  const price = await currentProPrice(db, now);
  let queued = 0;
  for (const row of rows) {
    const left = row.endsAt.getTime() - now.getTime();
    const which = left <= DAY_MS ? '1d' : '7d';
    const sent = await mailOwner(db, input.sealing, {
      profileId: personOf(row.profileId),
      type: 'pro_renewal_reminder',
      data: {
        daysLeft: which === '1d' ? 1 : 7,
        endDate: lagosDateWords(row.endsAt),
        graceEndDate: lagosDateWords(row.graceEndsAt),
        ...(price ? { priceMinor: String(price.amountMinor) } : {}),
      },
      dedupeKey: `pro_reminder.${row.id}.${which}`,
      now,
    });
    if (sent) queued += 1;
  }
  return { queued };
}
