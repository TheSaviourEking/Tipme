import { z } from 'zod';

// Campaign Studio (the ProCampaigns board, approved 11 Nov 2026; owner default ruling 2): a named
// link and QR for each place the person shares. Only a tracked link: no goal, target, end date or
// stated purpose. Counts only, never who. The link is `/@handle/<ending>`, which opens the normal
// tip page with no campaign name on it.

export const CAMPAIGN_NAME_MAX = 40;
/** Lower-case letters, digits and dashes, 1–30, not starting or ending with a dash. */
export const CAMPAIGN_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
/** Active (not stopped) campaigns a page may have (owner default ruling 2). */
export const FREE_CAMPAIGN_LIMIT = 1;
export const PRO_CAMPAIGN_LIMIT = 20;
/** Below this many tips a row or week shows "Fewer than 3" and hides the amount. */
export const CAMPAIGN_MIN_TIPS = 3;

const name = z
  .string()
  .transform((value) => value.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' '))
  .pipe(z.string().trim().min(1).max(CAMPAIGN_NAME_MAX));

export const campaignCreateSchema = z
  .object({ name, slug: z.string().regex(CAMPAIGN_SLUG_PATTERN) })
  .strict();
export type CampaignCreateRequest = z.infer<typeof campaignCreateSchema>;

export const campaignRenameSchema = z.object({ name }).strict();
export type CampaignRenameRequest = z.infer<typeof campaignRenameSchema>;

/**
 * Tips and what they brought. Under 3 tips (and more than none) `tips` and `receivedNetMinor` are
 * null, so no single supporter can be picked out.
 */
export interface CampaignResults {
  /** Page opens from this link or its QR (anonymous events only); null when not counted. */
  visits: number | null;
  tips: number | null;
  receivedNetMinor: string | null;
}

export interface CampaignRow extends CampaignResults {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  stoppedAt: string | null;
}

export interface CampaignList {
  /** The page's handle, for the link. */
  handle: string;
  limit: number;
  /** Active campaigns. */
  used: number;
  /** Results over the last 30 days (Lagos), the stopped ones included. */
  since: string;
  campaigns: CampaignRow[];
  /** The plain page link, not from a campaign, over the same days. */
  pageLink: CampaignResults;
}

export interface CampaignWeek extends Omit<CampaignResults, 'visits'> {
  /** Monday. */
  from: string;
}

export interface CampaignDetail extends CampaignRow {
  handle: string;
  displayName: string;
  /** Since it was made. */
  weeks: CampaignWeek[];
}
