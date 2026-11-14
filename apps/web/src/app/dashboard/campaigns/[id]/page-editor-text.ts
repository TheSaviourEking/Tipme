import {
  COVER_ANIMATIONS,
  COVER_COLOURS,
  COVER_DESIGNS,
  type CampaignPageSettings,
  type CoverDesignChoice,
} from '@tipme/contracts';

// Words for the campaign Page tab (ProCampaignPages board, section 2), kept free of React.

/** "43 of 60": counted in code points, as the server counts (an emoji counts once). */
export const counterText = (value: string, max: number): string =>
  `${Array.from(value).length} of ${max}`;

/** The cover row's summary on a phone: "Scattered hearts, violet", "Pulse, slow loop". */
export function coverSummary(cover: CoverDesignChoice | null): string {
  if (!cover) return 'Same as page';
  if (cover.animation) {
    const name =
      COVER_ANIMATIONS.find((a) => a.id === cover.animation)?.name ??
      'Animated';
    return `${name}, ${cover.motion === 'loop' ? 'slow loop' : 'plays once'}`;
  }
  const design = COVER_DESIGNS.find((d) => d.id === cover.design);
  if (!design) return 'Same as page';
  const colour = design.colours
    ? COVER_COLOURS.find((c) => c.id === cover.colour)
    : undefined;
  return colour ? `${design.name}, ${colour.name.toLowerCase()}` : design.name;
}

/** One line for the page as a whole. */
export function pageSummary(page: CampaignPageSettings): string {
  if (!page.on) return 'Off: the link opens your normal page';
  return `On · ${coverSummary(page.cover)}`;
}
