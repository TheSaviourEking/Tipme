import { z } from 'zod';
import {
  coverDesignChoiceSchema,
  type CoverDesignChoice,
  type ResolvedCover,
} from './covers.js';
import { cleanThanksLine, hasLink } from './thanks.js';

// Campaign pages (Pro; plan 2026-11-14 Phase A, board ProCampaignPages section 2). A campaign may
// have its own page at its link: a headline, a short description and a cover. It is always the
// same person and the same tip area; nothing here touches amounts, fees or the pay button.

export const CAMPAIGN_HEADLINE_MAX = 60;
export const CAMPAIGN_DESCRIPTION_MAX = 200;

const codePoints = (text: string) => Array.from(text).length;

/** The thank-you line's rules: invisible characters out, '' is "none", no links, a code-point cap. */
const pageText = (max: number) =>
  z
    .string()
    // Generous before cleaning (spaces collapse); the real limit is checked after.
    .max(max * 8)
    .nullable()
    .transform((raw) => {
      if (raw === null) return null;
      const cleaned = cleanThanksLine(raw);
      return cleaned === '' ? null : cleaned;
    })
    .refine((text) => text === null || codePoints(text) <= max, {
      message: `At most ${max} characters.`,
    })
    .refine((text) => text === null || !hasLink(text), {
      message: 'No links.',
    });

/** A cover choice; an empty one (no design, no animation) is "Same as page", as null is. */
const campaignCover = coverDesignChoiceSchema
  .nullable()
  .transform((cover) =>
    cover && (cover.design !== null || cover.animation) ? cover : null,
  );

/** `PUT /v1/me/campaigns/:id/page`. */
export const campaignPageSchema = z
  .object({
    on: z.boolean(),
    headline: pageText(CAMPAIGN_HEADLINE_MAX),
    description: pageText(CAMPAIGN_DESCRIPTION_MAX),
    cover: campaignCover,
  })
  .strict()
  .refine((page) => !page.on || page.headline !== null, {
    path: ['headline'],
    message: 'Add a headline to give it its own page.',
  });
export type CampaignPageRequest = z.output<typeof campaignPageSchema>;

/** What the editor shows (Pro and lapsed Pro alike: a lapse hides the page and keeps this). */
export interface CampaignPageSettings {
  on: boolean;
  headline: string | null;
  description: string | null;
  /** null: "Same as page". */
  cover: CoverDesignChoice | null;
}

/**
 * `GET /v1/profiles/:handle/campaigns/:slug`: only what a supporter sees. Never the campaign's id,
 * name or results. Tip goals (Phase B) add `goal`.
 */
export interface PublicCampaignPage {
  slug: string;
  headline: string;
  description?: string;
  /** Absent: the page's own cover. */
  cover?: ResolvedCover;
}
