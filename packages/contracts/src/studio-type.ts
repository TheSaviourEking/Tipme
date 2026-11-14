/**
 * Page Studio type scale and font library (plan 2026-11-12-page-studio, Task 2).
 *
 * Fonts are self-hosted WOFF2 files in `apps/web/public/fonts/studio/`, cut from google/fonts at a
 * pinned commit by `scripts/studio-fonts.mjs` (which also measured the metrics below). A page uses
 * at most two families, one for headings and one for text, so it loads at most 2 files and well
 * under 200 KB of fonts. Every size is a `clamp()` between a 320px and a 1440px screen.
 */

export type StudioFontId =
  | 'manrope'
  | 'dm-serif-display'
  | 'inter'
  | 'work-sans'
  | 'space-grotesk'
  | 'bricolage-grotesque'
  | 'outfit'
  | 'nunito'
  | 'fraunces'
  | 'source-serif-4';

export interface StudioFont {
  id: StudioFontId;
  name: string;
  category: 'sans' | 'serif' | 'rounded' | 'display';
  roles: readonly ('heading' | 'body')[];
  files: readonly {
    path: `/fonts/studio/${string}.woff2`;
    /** One weight, or the range a variable file keeps ("400 700"). */
    weight: `${number}` | `${number} ${number}`;
    style: 'normal';
    bytes: number;
  }[];
  headingWeight: number;
  bodyWeight?: number;
  /**
   * In font units, from the hhea and OS/2 tables. `avgAdvance`: mean advance of a–z and space.
   * `maxWordAdvance`: the widest letter (A–Z, a–z, Ẹ Ọ Ṣ Ị Ụ Ṅ), the per-letter upper bound the
   * design check uses for how wide a word can be.
   */
  metrics: {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    lineGap: number;
    xHeight: number;
    avgAdvance: number;
    maxWordAdvance: number;
  };
  /** A local font scaled to the same average width and line box, so the swap barely shifts text. */
  fallback: {
    family: 'Arial' | 'Georgia';
    sizeAdjust: string;
    ascentOverride: string;
    descentOverride: string;
  };
  /**
   * Heading-only fonts that miss a required character (Ṣ, ₦, a tone mark…): a heading containing
   * one is set wholly in the page's text font, never letter by letter in a stranger font.
   */
  wordFallback: boolean;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Letters a font may lack without harm, so they are not required: the ligatures Ĳ ĳ, the
 * deprecated ŉ, the archaic ĸ ſ, and the rare Ĭ ĭ and Ŧ ŧ. (Source Serif 4, the only serif
 * that draws every Nigerian letter and the naira sign, lacks Ĭ and Ŧ.)
 */
const NOT_REQUIRED = new Set([
  0x12c, 0x12d, 0x132, 0x133, 0x138, 0x149, 0x166, 0x167, 0x17f,
]);

/**
 * The characters a body font must draw: Basic Latin, Latin-1 (not the soft hyphen, which is never
 * drawn), Latin Extended-A (less NOT_REQUIRED), the Yoruba and Igbo letters Ẹ ẹ Ọ ọ Ṣ ṣ Ị ị Ụ ụ Ṅ ṅ,
 * the combining marks those languages and European names put on letters, the naira sign, and the
 * punctuation people type or autocorrect gives them.
 */
export const STUDIO_REQUIRED_CODEPOINTS: readonly number[] = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff).filter((c) => c !== 0xad),
  ...range(0x100, 0x17f).filter((c) => !NOT_REQUIRED.has(c)),
  0x1e44,
  0x1e45,
  0x1e62,
  0x1e63,
  0x1eb8,
  0x1eb9,
  0x1eca,
  0x1ecb,
  0x1ecc,
  0x1ecd,
  0x1ee4,
  0x1ee5,
  0x300,
  0x301,
  0x302,
  0x303,
  0x304,
  0x306,
  0x307,
  0x308,
  0x30a,
  0x30c,
  0x323,
  0x327,
  0x328,
  0x20a6,
  0x2013,
  0x2014,
  0x2018,
  0x2019,
  0x201a,
  0x201c,
  0x201d,
  0x201e,
  0x2022,
  0x2026,
  0x2039,
  0x203a,
];

/**
 * The library: 10 of the plan's 14 families. A family sets text only if it draws every required
 * character; the others are heading-only (Manrope lacks Ṣ and ₦ upstream). IBM Plex Sans, Lora,
 * Playfair Display and Libre Baskerville are not shipped: their licences reserve the family's own
 * name, which a subset may not use without the authors' written permission (OFL 1.1 §3).
 */
export const STUDIO_FONTS: readonly StudioFont[] = [
  {
    id: 'manrope',
    name: 'Manrope',
    category: 'sans',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/manrope-700.woff2',
        weight: '700',
        style: 'normal',
        bytes: 18188,
      },
    ],
    headingWeight: 700,
    metrics: {
      unitsPerEm: 2000,
      ascent: 2132,
      descent: -600,
      lineGap: 0,
      xHeight: 1080,
      avgAdvance: 1079,
      maxWordAdvance: 1951,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '111.94%',
      ascentOverride: '95.23%',
      descentOverride: '26.80%',
    },
    wordFallback: true,
  },
  {
    id: 'dm-serif-display',
    name: 'DM Serif Display',
    category: 'display',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/dm-serif-display-400.woff2',
        weight: '400',
        style: 'normal',
        bytes: 20636,
      },
    ],
    headingWeight: 400,
    metrics: {
      unitsPerEm: 1000,
      ascent: 1036,
      descent: -335,
      lineGap: 0,
      xHeight: 481,
      avgAdvance: 504,
      maxWordAdvance: 921,
    },
    fallback: {
      family: 'Georgia',
      sizeAdjust: '102.91%',
      ascentOverride: '100.67%',
      descentOverride: '32.55%',
    },
    wordFallback: true,
  },
  {
    id: 'inter',
    name: 'Inter',
    category: 'sans',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/inter-400-700.woff2',
        weight: '400 700',
        style: 'normal',
        bytes: 63180,
      },
    ],
    headingWeight: 700,
    bodyWeight: 400,
    metrics: {
      unitsPerEm: 2048,
      ascent: 1984,
      descent: -494,
      lineGap: 0,
      xHeight: 1118,
      avgAdvance: 1079,
      maxWordAdvance: 2018,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '109.32%',
      ascentOverride: '88.62%',
      descentOverride: '22.06%',
    },
    wordFallback: false,
  },
  {
    id: 'work-sans',
    name: 'Work Sans',
    category: 'sans',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/work-sans-400-600.woff2',
        weight: '400 600',
        style: 'normal',
        bytes: 45256,
      },
    ],
    headingWeight: 600,
    bodyWeight: 400,
    metrics: {
      unitsPerEm: 1000,
      ascent: 930,
      descent: -243,
      lineGap: 0,
      xHeight: 500,
      avgAdvance: 540,
      maxWordAdvance: 961,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '112.05%',
      ascentOverride: '83.00%',
      descentOverride: '21.69%',
    },
    wordFallback: false,
  },
  {
    id: 'space-grotesk',
    name: 'Space Grotesk',
    category: 'sans',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/space-grotesk-600.woff2',
        weight: '600',
        style: 'normal',
        bytes: 19864,
      },
    ],
    headingWeight: 600,
    metrics: {
      unitsPerEm: 1000,
      ascent: 984,
      descent: -292,
      lineGap: 0,
      xHeight: 486,
      avgAdvance: 545,
      maxWordAdvance: 892,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '113.09%',
      ascentOverride: '87.01%',
      descentOverride: '25.82%',
    },
    wordFallback: false,
  },
  {
    id: 'bricolage-grotesque',
    name: 'Bricolage Grotesque',
    category: 'display',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/bricolage-grotesque-700.woff2',
        weight: '700',
        style: 'normal',
        bytes: 26160,
      },
    ],
    headingWeight: 700,
    metrics: {
      unitsPerEm: 1000,
      ascent: 930,
      descent: -270,
      lineGap: 0,
      xHeight: 525,
      avgAdvance: 495,
      maxWordAdvance: 909,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '102.71%',
      ascentOverride: '90.55%',
      descentOverride: '26.29%',
    },
    wordFallback: true,
  },
  {
    id: 'outfit',
    name: 'Outfit',
    category: 'sans',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/outfit-600.woff2',
        weight: '600',
        style: 'normal',
        bytes: 16452,
      },
    ],
    headingWeight: 600,
    metrics: {
      unitsPerEm: 1000,
      ascent: 1000,
      descent: -260,
      lineGap: 0,
      xHeight: 483,
      avgAdvance: 504,
      maxWordAdvance: 992,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '104.58%',
      ascentOverride: '95.62%',
      descentOverride: '24.86%',
    },
    wordFallback: true,
  },
  {
    id: 'nunito',
    name: 'Nunito',
    category: 'rounded',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/nunito-400-700.woff2',
        weight: '400 700',
        style: 'normal',
        bytes: 39072,
      },
    ],
    headingWeight: 700,
    bodyWeight: 400,
    metrics: {
      unitsPerEm: 1000,
      ascent: 1011,
      descent: -353,
      lineGap: 0,
      xHeight: 484,
      avgAdvance: 498,
      maxWordAdvance: 1101,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '103.33%',
      ascentOverride: '97.84%',
      descentOverride: '34.16%',
    },
    wordFallback: false,
  },
  {
    id: 'fraunces',
    name: 'Fraunces',
    category: 'serif',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/fraunces-600.woff2',
        weight: '600',
        style: 'normal',
        bytes: 25328,
      },
    ],
    headingWeight: 600,
    metrics: {
      unitsPerEm: 2000,
      ascent: 1956,
      descent: -510,
      lineGap: 0,
      xHeight: 964,
      avgAdvance: 1092,
      maxWordAdvance: 2128,
    },
    fallback: {
      family: 'Georgia',
      sizeAdjust: '111.49%',
      ascentOverride: '87.72%',
      descentOverride: '22.87%',
    },
    wordFallback: true,
  },
  {
    id: 'source-serif-4',
    name: 'Source Serif 4',
    category: 'serif',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/source-serif-4-400-600.woff2',
        weight: '400 600',
        style: 'normal',
        bytes: 40904,
      },
    ],
    headingWeight: 600,
    bodyWeight: 400,
    metrics: {
      unitsPerEm: 1000,
      ascent: 1036,
      descent: -335,
      lineGap: 0,
      xHeight: 475,
      avgAdvance: 500,
      maxWordAdvance: 962,
    },
    fallback: {
      family: 'Georgia',
      sizeAdjust: '102.09%',
      ascentOverride: '101.48%',
      descentOverride: '32.81%',
    },
    wordFallback: false,
  },
];

/** A new page, and a page whose font was retired, use these. */
export const STUDIO_DEFAULT_FONTS = {
  heading: 'manrope',
  body: 'inter',
} as const satisfies { heading: StudioFontId; body: StudioFontId };

/** Whether this pair is allowed: each font can take its role (one id for both is one family). */
export function fontsOk(heading: StudioFontId, body: StudioFontId): boolean {
  const h = STUDIO_FONTS.find((f) => f.id === heading);
  const b = STUDIO_FONTS.find((f) => f.id === body);
  return Boolean(h?.roles.includes('heading') && b?.roles.includes('body'));
}

export type StudioScaleStep = 'compact' | 'standard' | 'roomy';
export type StudioTextRole = 'display' | 'h2' | 'h3' | 'body' | 'small';

export interface StudioTypeSize {
  /** px at a 320px screen and at 1440px; `css` is the clamp() between them. */
  min: number;
  max: number;
  css: string;
  lineHeight: number;
  measure: string;
}

const RATIO: Record<StudioScaleStep, number> = {
  compact: 1.2,
  standard: 1.25,
  roomy: 1.333,
};

const NARROW = 320;
const WIDE = 1440;
const round = (n: number, places: number) => Number(n.toFixed(places));

function fluid(min: number, max: number): string {
  const slope = (max - min) / (WIDE - NARROW);
  // Rounded down, so the fluid size never passes `min` at 320px (display stays ≤ 40px).
  const rem = Math.floor(((min - slope * NARROW) / 16) * 1e4) / 1e4;
  return `clamp(${min}px, ${rem}rem + ${round(slope * 100, 4)}vw, ${max}px)`;
}

/**
 * Body is 16–18px; each step up multiplies both ends by the ratio (h3 once, h2 twice, display four
 * times); small divides by it. Display never passes 40px on a 320px screen, small never drops
 * below 13px. Body text keeps a 68-character line; headings 24.
 */
export function studioTypeScale(
  step: StudioScaleStep,
): Record<StudioTextRole, StudioTypeSize> {
  const r = RATIO[step];
  const size = (
    power: number,
    lineHeight: number,
    measure: string,
    floor = 0,
    cap = Infinity,
  ) => {
    const min = round(Math.min(cap, Math.max(floor, 16 * r ** power)), 2);
    const max = round(Math.max(min, 18 * r ** power), 2);
    return { min, max, css: fluid(min, max), lineHeight, measure };
  };
  return {
    display: size(4, 1.1, '24ch', 0, 40),
    h2: size(2, 1.2, '24ch'),
    h3: size(1, 1.3, '24ch'),
    body: {
      min: 16,
      max: 18,
      css: 'clamp(16px, 0.95rem + 0.25vw, 18px)',
      lineHeight: 1.6,
      measure: '68ch',
    },
    small: size(-1, 1.5, '68ch', 13),
  };
}

/** Row spacing steps, px at 320 and 1440. */
export const STUDIO_SPACING = {
  s: { min: 16, max: 24 },
  m: { min: 24, max: 48 },
  l: { min: 40, max: 80 },
} as const;
