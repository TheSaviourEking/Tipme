import {
  resolveCover,
  type CampaignPageRequest,
  type CampaignPageSettings,
  type CoverDesignChoice,
  type PublicCampaignPage,
} from '@tipme/contracts';
import { campaignSlugProblem, normaliseHandle } from '@tipme/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { campaigns, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';

/*
 * Campaign pages (Pro; plan 2026-11-14 Phase A, board ProCampaignPages). A campaign's own headline,
 * description and cover, shown above the same person's same tip area at the campaign's link. Pro
 * is read from `profiles.plan` on every save and every read; a lapse hides the page and keeps it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CampaignRow = typeof campaigns.$inferSelect;

/** The stored cover choice, or null for "Same as page". */
export function campaignCoverChoice(
  row: Pick<
    CampaignRow,
    'coverDesign' | 'coverColour' | 'coverAnimation' | 'coverMotion'
  >,
): CoverDesignChoice | null {
  if (row.coverAnimation)
    return {
      design: null,
      animation: row.coverAnimation,
      ...(row.coverColour ? { colour: row.coverColour } : {}),
      ...(row.coverMotion === 'once' || row.coverMotion === 'loop'
        ? { motion: row.coverMotion }
        : {}),
    };
  if (row.coverDesign)
    return { design: row.coverDesign, colour: row.coverColour ?? null };
  return null;
}

/** What the editor shows for a campaign. */
export function campaignPageSettings(row: CampaignRow): CampaignPageSettings {
  return {
    on: row.pageOn,
    headline: row.headline,
    description: row.description,
    cover: campaignCoverChoice(row),
  };
}

/**
 * Ruling G9: the headline may not carry another page's handle (`@tobi`, an old handle included)
 * or be another live page's display name. The person's own handle and name are fine.
 */
async function headlineNamesSomeoneElse(
  db: Pick<Database, 'execute'>,
  profileId: string,
  headline: string,
): Promise<boolean> {
  const handles = [...headline.matchAll(/@([a-z0-9_]+)/gi)]
    .map((match) => normaliseHandle(match[1] ?? ''))
    .filter((handle): handle is string => handle !== null);
  const name = headline.replace(/\s+/g, ' ').trim().toLowerCase();
  const handleList = handles.length
    ? sql.join(
        handles.map((handle) => sql`${handle}`),
        sql`, `,
      )
    : sql`NULL`;
  const found = await db.execute<{ yes: number }>(sql`
    SELECT 1 AS yes FROM profiles
     WHERE id <> ${profileId} AND handle_lower IN (${handleList})
    UNION ALL
    SELECT 1 FROM handle_aliases
     WHERE profile_id <> ${profileId} AND handle_lower IN (${handleList})
    UNION ALL
    SELECT 1 FROM profiles
     WHERE id <> ${profileId} AND page_state = 'live'
       AND lower(btrim(regexp_replace(display_name, '\\s+', ' ', 'g'))) = ${name}
    LIMIT 1`);
  return found.rows.length > 0;
}

/** Saves a campaign's page (Pro only). Returns what is stored. */
export function saveCampaignPage(
  db: Database,
  profileId: string,
  id: string,
  input: CampaignPageRequest,
): Promise<CampaignPageSettings> {
  if (!UUID.test(id))
    return Promise.reject(new OperationError('CAMPAIGN_NOT_FOUND'));
  return guarded(() =>
    db.transaction(async (tx) => {
      // The page lock orders this after any plan change in flight (recomputePlan takes it too).
      const [page] = await tx
        .select({ plan: profiles.plan })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .for('update');
      if (!page) throw new OperationError('CAMPAIGN_NOT_FOUND');
      const [campaign] = await tx
        .select({ stoppedAt: campaigns.stoppedAt })
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.profileId, profileId)));
      if (!campaign) throw new OperationError('CAMPAIGN_NOT_FOUND');
      if (campaign.stoppedAt) throw new OperationError('CAMPAIGN_STOPPED');
      if (page.plan !== 'pro')
        throw new OperationError('CAMPAIGN_PRO_REQUIRED');
      if (
        input.headline !== null &&
        (await headlineNamesSomeoneElse(tx, profileId, input.headline))
      )
        throw new OperationError('CAMPAIGN_HEADLINE_NAME');
      const cover = input.cover;
      const animated = !!cover?.animation;
      const [row] = await tx
        .update(campaigns)
        .set({
          pageOn: input.on,
          headline: input.headline,
          description: input.description,
          coverDesign: cover && !animated ? cover.design : null,
          coverColour: cover?.colour ?? null,
          coverAnimation: animated ? (cover?.animation ?? null) : null,
          coverMotion: animated ? (cover?.motion ?? null) : null,
        })
        .where(
          and(
            eq(campaigns.id, id),
            eq(campaigns.profileId, profileId),
            isNull(campaigns.stoppedAt),
            // Pro checked again in the write itself.
            sql`EXISTS (SELECT 1 FROM profiles p WHERE p.id = ${profileId} AND p.plan = 'pro')`,
          ),
        )
        .returning();
      if (!row) throw new OperationError('CAMPAIGN_PRO_REQUIRED');
      return campaignPageSettings(row);
    }),
  );
}

/**
 * A campaign's public page: only when the page is live and Pro, the campaign runs, its page is on
 * and it has a headline. Otherwise null, and the link opens the main page as before.
 */
export function publicCampaignPage(
  db: Database,
  rawHandle: string,
  slug: string,
): Promise<PublicCampaignPage | null> {
  const handle = normaliseHandle(rawHandle);
  if (!handle || campaignSlugProblem(slug) === 'format')
    return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({
        campaign: campaigns,
        plan: profiles.plan,
        handle: profiles.handle,
      })
      .from(campaigns)
      .innerJoin(profiles, eq(profiles.id, campaigns.profileId))
      .where(
        and(
          eq(profiles.handleLower, handle),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
          eq(profiles.plan, 'pro'),
          eq(campaigns.slug, slug),
          isNull(campaigns.stoppedAt),
          eq(campaigns.pageOn, true),
        ),
      );
    const headline = row?.campaign.headline;
    if (!row || !headline) return null;
    const { campaign } = row;
    const choice = campaignCoverChoice(campaign);
    return {
      slug: campaign.slug,
      headline,
      ...(campaign.description ? { description: campaign.description } : {}),
      ...(choice
        ? {
            cover: resolveCover({
              handle: row.handle,
              coverPath: null,
              coverDesign: campaign.coverDesign,
              coverColour: campaign.coverColour,
              coverAnimation: campaign.coverAnimation,
              coverMotion: campaign.coverMotion,
              plan: row.plan,
            }),
          }
        : {}),
    };
  });
}
