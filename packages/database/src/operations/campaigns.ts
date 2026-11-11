import {
  CAMPAIGN_MIN_TIPS,
  FREE_CAMPAIGN_LIMIT,
  PRO_CAMPAIGN_LIMIT,
  type CampaignDetail,
  type CampaignList,
  type CampaignResults,
  type CampaignRow,
} from '@tipme/contracts';
import { campaignSlugProblem, mondayOfDate } from '@tipme/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { campaigns, profiles, tipCampaigns } from '../schema.js';
import { lagosDay } from './earnings.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';

// Campaign Studio (ProCampaigns board; owner default ruling 2: Pro 20 running, Free 1). A campaign
// is only a tracked link. Counts only, never who: under 3 tips the count and amount are hidden.

const ZONE = 'Africa/Lagos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
/** Visits for the last days come from raw events; older days from the daily totals. */
const RAW_DAYS = 6;

export const campaignLimitFor = (plan: string) =>
  plan === 'pro' ? PRO_CAMPAIGN_LIMIT : FREE_CAMPAIGN_LIMIT;

/** Under 3 tips (but some), neither the count nor the amount is shown. */
function results(
  visits: number | null,
  tips: number,
  net: string,
): CampaignResults {
  const hidden = tips > 0 && tips < CAMPAIGN_MIN_TIPS;
  return {
    visits,
    tips: hidden ? null : tips,
    receivedNetMinor: hidden ? null : net,
  };
}

/** The running campaign of a page with this ending, for a tip or a visit; null otherwise. */
export async function runningCampaignId(
  tx: Database | Tx,
  profileId: string,
  slug: string | undefined,
): Promise<string | null> {
  if (!slug || campaignSlugProblem(slug) === 'format') return null;
  const [row] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.profileId, profileId),
        eq(campaigns.slug, slug),
        isNull(campaigns.stoppedAt),
      ),
    );
  return row?.id ?? null;
}

/** Records which campaign a new tip came from; a replayed or unknown one records nothing. */
export async function attributeTip(
  tx: Tx,
  input: { profileId: string; tipId: string; slug: string | undefined },
): Promise<void> {
  const campaignId = await runningCampaignId(tx, input.profileId, input.slug);
  if (campaignId)
    await tx
      .insert(tipCampaigns)
      .values({ tipId: input.tipId, campaignId })
      .onConflictDoNothing();
}

export function createCampaign(
  db: Database,
  profileId: string,
  input: { name: string; slug: string; now?: Date },
): Promise<CampaignRow> {
  const problem = campaignSlugProblem(input.slug);
  if (problem)
    return Promise.reject(new OperationError('CAMPAIGN_SLUG_UNAVAILABLE'));
  return guarded(() =>
    db.transaction(async (tx) => {
      // The page lock makes the limit hold under parallel creates.
      const [page] = await tx
        .select({ plan: profiles.plan, handleLower: profiles.handleLower })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .for('update');
      if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      // Another person's handle (or an old one still pointing at a page) can't be an ending, so
      // /@ada/tobi never reads as Tobi's page.
      const handle = input.slug.replaceAll('-', '_');
      const other = await tx.execute<{ yes: number }>(sql`
        SELECT 1 AS yes FROM profiles WHERE handle_lower = ${handle} AND id <> ${profileId}
        UNION ALL SELECT 1 FROM handle_aliases WHERE handle_lower = ${handle}
        LIMIT 1`);
      if (other.rows.length > 0)
        throw new OperationError('CAMPAIGN_SLUG_UNAVAILABLE');
      const running = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM campaigns WHERE profile_id = ${profileId} AND stopped_at IS NULL`);
      if ((running.rows[0]?.n ?? 0) >= campaignLimitFor(page.plan))
        throw new OperationError('CAMPAIGN_LIMIT');
      const now = input.now ?? new Date();
      const inserted = await tx
        .insert(campaigns)
        .values({
          id: newId(),
          profileId,
          name: input.name,
          slug: input.slug,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (!row) throw new OperationError('CAMPAIGN_SLUG_TAKEN');
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt.toISOString(),
        stoppedAt: null,
        visits: 0,
        tips: 0,
        receivedNetMinor: '0',
      };
    }),
  );
}

export function renameCampaign(
  db: Database,
  profileId: string,
  id: string,
  name: string,
): Promise<void> {
  if (!UUID.test(id))
    return Promise.reject(new OperationError('CAMPAIGN_NOT_FOUND'));
  return guarded(async () => {
    const updated = await db
      .update(campaigns)
      .set({ name })
      .where(and(eq(campaigns.id, id), eq(campaigns.profileId, profileId)))
      .returning({ id: campaigns.id });
    if (!updated[0]) throw new OperationError('CAMPAIGN_NOT_FOUND');
  });
}

/** Stops a campaign: results are kept, and its link opens the page like the usual link. */
export function stopCampaign(
  db: Database,
  profileId: string,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  if (!UUID.test(id))
    return Promise.reject(new OperationError('CAMPAIGN_NOT_FOUND'));
  return guarded(async () => {
    const [row] = await db
      .select({ stoppedAt: campaigns.stoppedAt })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.profileId, profileId)));
    if (!row) throw new OperationError('CAMPAIGN_NOT_FOUND');
    if (row.stoppedAt) return;
    await db
      .update(campaigns)
      .set({ stoppedAt: now })
      .where(eq(campaigns.id, id));
  });
}

/**
 * Visits per campaign from `from` to today: page opens from the link, one per tab and day, from
 * the anonymous events only (none for GPC or DNT browsers). Days older than RAW_DAYS come from
 * the daily totals, so results outlive the 90-day raw retention.
 */
async function visitsSince(
  db: Database,
  profileId: string,
  from: string,
  today: string,
): Promise<Map<string, number>> {
  const cutoff = shift(today, -RAW_DAYS);
  const rows = await db.execute<{ id: string; visits: string }>(sql`
    WITH mine AS (SELECT id FROM campaigns WHERE profile_id = ${profileId}),
    rolled AS (
      SELECT d.dimension AS id, SUM(d.value) AS visits FROM analytics_daily d
       WHERE d.metric = 'campaign_visits' AND d.dimension IN (SELECT id::text FROM mine)
         AND d.date >= ${from}::date AND d.date < GREATEST(${cutoff}::date, ${from}::date)
       GROUP BY 1),
    raw AS (
      SELECT e.campaign_id::text AS id,
             COUNT(DISTINCT (e.flow_id, (e.at_minute AT TIME ZONE ${ZONE})::date)) AS visits
        FROM analytics_events e
       WHERE e.name = 'profile_viewed' AND NOT e.rehearsal AND e.flow_id IS NOT NULL
         AND e.campaign_id IN (SELECT id FROM mine)
         AND e.at_minute >= (GREATEST(${cutoff}::date, ${from}::date)::timestamp AT TIME ZONE ${ZONE})
       GROUP BY 1)
    SELECT id, SUM(visits)::text AS visits FROM (SELECT * FROM rolled UNION ALL SELECT * FROM raw) v
     GROUP BY id`);
  return new Map(rows.rows.map((row) => [row.id, Number(row.visits)]));
}

/** Paid tips per campaign (null id: not from a campaign) confirmed from `from` (Lagos). */
async function tipsSince(db: Database, profileId: string, from: string) {
  const rows = await db.execute<{
    id: string | null;
    tips: number;
    net: string;
  }>(sql`
    SELECT tc.campaign_id AS id, COUNT(*)::int AS tips, SUM(q.recipient_net_minor)::text AS net
      FROM tips t
      JOIN payment_intents i ON i.id = t.intent_id
      JOIN tip_quotes q ON q.id = i.quote_id
      LEFT JOIN tip_campaigns tc ON tc.tip_id = t.id
     WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND t.completed_at IS NOT NULL
       AND t.completed_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
     GROUP BY 1`);
  return new Map(rows.rows.map((row) => [row.id, row]));
}

/** The page's campaigns, newest first, with the last 30 days' results; and the plain link's. */
export function listCampaigns(
  db: Database,
  profileId: string,
  now: Date = new Date(),
): Promise<CampaignList> {
  const today = lagosDay(now);
  const since = shift(today, -29);
  return guarded(async () => {
    const [page] = await db
      .select({ plan: profiles.plan, handle: profiles.handle })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    if (!page) throw new OperationError('PROFILE_NOT_FOUND');
    const rows = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.profileId, profileId))
      .orderBy(sql`${campaigns.createdAt} DESC, ${campaigns.id} DESC`);
    const [visits, tips] = await Promise.all([
      visitsSince(db, profileId, since, today),
      tipsSince(db, profileId, since),
    ]);
    // The plain page link: opens of this page not from a running campaign (raw, 30 days < 90).
    const plain = await db.execute<{ visits: number }>(sql`
      SELECT COUNT(DISTINCT (e.flow_id, (e.at_minute AT TIME ZONE ${ZONE})::date))::int AS visits
        FROM analytics_events e JOIN profiles p ON p.handle_lower = e.handle
       WHERE p.id = ${profileId} AND e.name = 'profile_viewed' AND NOT e.rehearsal
         AND e.flow_id IS NOT NULL AND e.campaign_id IS NULL
         AND e.at_minute >= (${since}::date::timestamp AT TIME ZONE ${ZONE})`);
    const none = tips.get(null);
    return {
      handle: page.handle,
      limit: campaignLimitFor(page.plan),
      used: rows.filter((row) => !row.stoppedAt).length,
      since,
      campaigns: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt.toISOString(),
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
        ...results(
          visits.get(row.id) ?? 0,
          tips.get(row.id)?.tips ?? 0,
          tips.get(row.id)?.net ?? '0',
        ),
      })),
      pageLink: results(
        plain.rows[0]?.visits ?? 0,
        none?.tips ?? 0,
        none?.net ?? '0',
      ),
    };
  });
}

/** One campaign since it was made, with its weeks (Monday-started); null if not this page's. */
export function campaignDetail(
  db: Database,
  profileId: string,
  id: string,
  now: Date = new Date(),
): Promise<CampaignDetail | null> {
  if (!UUID.test(id)) return Promise.resolve(null);
  const today = lagosDay(now);
  return guarded(async () => {
    const [row] = await db
      .select({
        campaign: campaigns,
        handle: profiles.handle,
        displayName: profiles.displayName,
      })
      .from(campaigns)
      .innerJoin(profiles, eq(profiles.id, campaigns.profileId))
      .where(and(eq(campaigns.id, id), eq(campaigns.profileId, profileId)));
    if (!row) return null;
    const made = lagosDay(row.campaign.createdAt);
    const [visits, totals] = await Promise.all([
      visitsSince(db, profileId, made, today),
      db.execute<{ tips: number; net: string }>(sql`
        SELECT COUNT(*)::int AS tips, COALESCE(SUM(q.recipient_net_minor), 0)::text AS net
          FROM tip_campaigns tc JOIN tips t ON t.id = tc.tip_id
          JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
         WHERE tc.campaign_id = ${id} AND t.status = 'SUCCEEDED'`),
    ]);
    const weekly = await db.execute<{
      monday: string;
      tips: number;
      net: string;
    }>(sql`
      SELECT to_char(date_trunc('week', (t.completed_at AT TIME ZONE ${ZONE})::date), 'YYYY-MM-DD') AS monday,
             COUNT(*)::int AS tips, SUM(q.recipient_net_minor)::text AS net
        FROM tip_campaigns tc JOIN tips t ON t.id = tc.tip_id
        JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
       WHERE tc.campaign_id = ${id} AND t.status = 'SUCCEEDED' AND t.completed_at IS NOT NULL
       GROUP BY 1`);
    const byWeek = new Map(weekly.rows.map((week) => [week.monday, week]));
    const weeks = [];
    const first = mondayOfDate(made) ?? made;
    const last = mondayOfDate(today) ?? today;
    for (let monday = first; monday <= last; monday = shift(monday, 7)) {
      const week = byWeek.get(monday);
      const { tips, receivedNetMinor } = results(
        null,
        week?.tips ?? 0,
        week?.net ?? '0',
      );
      weeks.push({ from: monday, tips, receivedNetMinor });
    }
    const total = totals.rows[0];
    return {
      id: row.campaign.id,
      name: row.campaign.name,
      slug: row.campaign.slug,
      createdAt: row.campaign.createdAt.toISOString(),
      stoppedAt: row.campaign.stoppedAt?.toISOString() ?? null,
      handle: row.handle,
      displayName: row.displayName,
      ...results(visits.get(id) ?? 0, total?.tips ?? 0, total?.net ?? '0'),
      // At most the last 26 weeks on screen.
      weeks: weeks.slice(-26),
    };
  });
}
