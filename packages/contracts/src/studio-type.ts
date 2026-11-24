/**
 * Page Studio font library (plan 2026-11-12-page-studio, Task 2).
 *
 * Fonts are self-hosted WOFF2 files in `apps/web/public/fonts/studio/`, cut from google/fonts at a
 * pinned commit by `scripts/studio-fonts.mjs` (which also measured the metrics below). A page uses
 * at most two families, one for headings and one for text, so it loads at most 2 files and well
 * under 200 KB of fonts.
 */

export type StudioFontId =
  | 'dm-serif-display'
  | 'inter'
  | 'source-serif-4'
  | 'unbounded'
  | 'anton'
  | 'linen-serif';

export interface StudioFont {
  id: StudioFontId;
  name: string;
  category: 'sans' | 'serif' | 'rounded' | 'display';
  roles: readonly ('heading' | 'body')[];
  files: readonly {
    path: `/fonts/studio/${string}.woff2`;
    /** One weight, or the range a variable file keeps ("400 700"). */
    weight: `${number}` | `${number} ${number}`;
    style: 'normal' | 'italic';
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
  /** The required characters this font can't draw (empty for a text font). */
  missing: readonly number[];
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
 * punctuation people type or autocorrect gives them, and the Hausa hooked letters ɓ ɗ ƙ ƴ Ɓ Ɗ Ƙ Ƴ.
 */
export const STUDIO_REQUIRED_CODEPOINTS: readonly number[] = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff).filter((c) => c !== 0xad),
  ...range(0x100, 0x17f).filter((c) => !NOT_REQUIRED.has(c)),
  // The Hausa hooked letters: Ɓ Ɗ Ƙ ƙ Ƴ ƴ ɓ ɗ.
  0x181,
  0x18a,
  0x198,
  0x199,
  0x1b3,
  0x1b4,
  0x253,
  0x257,
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
 * The library: the 6 faces the styles use (Classic's DM Serif Display, Inter, Journal's Source Serif
 * 4, Signboard's Unbounded, Sprint's Anton, Linen's Serif). The v1 editor's other faces were retired
 * with it (PR 4b). A family sets text only if it draws every required character; the others are
 * heading-only. IBM Plex Sans, Lora, Playfair Display and Libre Baskerville are not shipped: their
 * licences reserve the family's own name, which a subset may not use without the authors' written
 * permission (OFL 1.1 §3). Gentium Book Plus is shipped renamed, as Linen Serif.
 */
export const STUDIO_FONTS: readonly StudioFont[] = [
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
    missing: [
      0x108, 0x109, 0x10a, 0x10b, 0x114, 0x115, 0x11c, 0x11d, 0x120, 0x121,
      0x124, 0x125, 0x126, 0x127, 0x128, 0x129, 0x134, 0x135, 0x14a, 0x14b,
      0x14e, 0x14f, 0x15c, 0x15d, 0x168, 0x169, 0x16c, 0x16d, 0x174, 0x175,
      0x176, 0x177, 0x181, 0x18a, 0x198, 0x199, 0x1b3, 0x1b4, 0x253, 0x257,
      0x1e44, 0x1e45, 0x1e62, 0x1e63, 0x1eb8, 0x1eb9, 0x1eca, 0x1ecb, 0x1ecc,
      0x1ecd, 0x1ee4, 0x1ee5, 0x323, 0x20a6,
    ],
  },
  {
    id: 'inter',
    name: 'Inter',
    category: 'sans',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/inter-400-800.woff2',
        weight: '400 800',
        style: 'normal',
        bytes: 66076,
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
    missing: [],
  },
  {
    id: 'source-serif-4',
    name: 'Source Serif 4',
    category: 'serif',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/source-serif-4-400-600.woff2',
        weight: '400 600',
        style: 'normal',
        bytes: 40904,
      },
      {
        path: '/fonts/studio/source-serif-4-400-italic.woff2',
        weight: '400',
        style: 'italic',
        bytes: 25052,
      },
    ],
    headingWeight: 600,
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
    // Draws every Nigerian letter and ₦ but not the Hausa hooked letters (checked 17 Nov 2026), so
    // a heading it cannot draw whole is set in Inter 700. Journal uses it for headings only.
    wordFallback: true,
    missing: [0x181, 0x18a, 0x198, 0x199, 0x1b3, 0x1b4, 0x253, 0x257],
  },
  {
    id: 'unbounded',
    name: 'Unbounded',
    category: 'display',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/unbounded-600-700.woff2',
        weight: '600 700',
        style: 'normal',
        bytes: 94160,
      },
    ],
    headingWeight: 700,
    metrics: {
      unitsPerEm: 1000,
      ascent: 995,
      descent: -245,
      lineGap: 0,
      xHeight: 570,
      avgAdvance: 704,
      maxWordAdvance: 1349,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '146.08%',
      ascentOverride: '68.11%',
      descentOverride: '16.77%',
    },
    wordFallback: true,
    missing: [0xb5],
  },
  {
    id: 'anton',
    name: 'Anton',
    category: 'display',
    roles: ['heading'],
    files: [
      {
        path: '/fonts/studio/anton-400.woff2',
        weight: '400',
        style: 'normal',
        bytes: 22524,
      },
    ],
    headingWeight: 400,
    metrics: {
      unitsPerEm: 2048,
      ascent: 2409,
      descent: -674,
      lineGap: 0,
      xHeight: 1500,
      avgAdvance: 916,
      maxWordAdvance: 1553,
    },
    fallback: {
      family: 'Arial',
      sizeAdjust: '92.81%',
      ascentOverride: '126.74%',
      descentOverride: '35.46%',
    },
    wordFallback: false,
    missing: [],
  },
  {
    // Gentium Book Plus, renamed: its licence reserves "Gentium" and "SIL", so the cut is a
    // Modified Version under another name (plan ruling R2; scripts/studio-fonts.mjs).
    id: 'linen-serif',
    name: 'Linen Serif',
    category: 'serif',
    roles: ['heading', 'body'],
    files: [
      {
        path: '/fonts/studio/linen-serif-400.woff2',
        weight: '400',
        style: 'normal',
        bytes: 40812,
      },
      {
        path: '/fonts/studio/linen-serif-700.woff2',
        weight: '700',
        style: 'normal',
        bytes: 40088,
      },
      {
        path: '/fonts/studio/linen-serif-400-italic.woff2',
        weight: '400',
        style: 'italic',
        bytes: 45724,
      },
    ],
    headingWeight: 700,
    bodyWeight: 400,
    metrics: {
      unitsPerEm: 2048,
      ascent: 2250,
      descent: -750,
      lineGap: 0,
      xHeight: 930,
      avgAdvance: 962,
      maxWordAdvance: 1741,
    },
    fallback: {
      family: 'Georgia',
      sizeAdjust: '95.91%',
      ascentOverride: '114.55%',
      descentOverride: '38.18%',
    },
    wordFallback: false,
    missing: [],
  },
];

/** The v1 document's type size step (`StudioDocumentV1['scale']`); the v1 type scale itself is gone. */
export type StudioScaleStep = 'compact' | 'standard' | 'roomy';
