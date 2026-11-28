/**
 * Page Studio styles (spec 2026-11-17-page-studio-styles, §5.1, §7.3, §9).
 *
 * A page picks one of eleven finished styles (the canvas's nine, then Creator and Professional
 * from the addendum 2026-11-27-studio-creator-professional-design) and one of eight tested
 * accents; it never stores a colour. This registry holds only what the API, the design check and
 * the editor must know: each style's neutrals per mode, its defaults, and the accent table. Radii,
 * type sizes, spacing and motion live in each style's CSS. Every value is copied from the spec
 * (which copies the canvas); the exhaustive contrast test proves every style × accent × mode pair.
 */

import {
  blend,
  contrastRatio,
  hexToOklch,
  oklchToHex,
  type Hex,
  type StudioMode,
} from './studio-colour.js';
import type {
  PhotoAccentFailed,
  PhotoAccentValues,
} from './studio-photo-accent.js';
import type { StudioFontId } from './studio-type.js';

export const STUDIO_STYLE_IDS = [
  'classic',
  'clear',
  'journal',
  'stage',
  'signboard',
  'sprint',
  'tiles',
  'linen',
  'horizon',
  // Addendum §5.1: appended, so every existing card position and fixture order stays.
  'creator',
  'professional',
] as const;
export type StudioStyleId = (typeof STUDIO_STYLE_IDS)[number];

export const STUDIO_ACCENT_IDS = [
  'ink',
  'blue',
  'lagoon',
  'green',
  'violet',
  'rose',
  'coral',
  'amber',
  'photo',
] as const;
export type StudioAccentId = (typeof STUDIO_ACCENT_IDS)[number];
export type StudioCuratedAccentId = Exclude<StudioAccentId, 'photo'>;

/** `fill` is the Tip button, `label` the text on it, `text` the accent as text on surfaces. */
export interface StudioAccentValues {
  fill: Hex;
  label: Hex;
  text: Hex;
}

type ModePair = { light: StudioAccentValues; dark: StudioAccentValues };

/** §7.3. Amber's light fill takes a dark label and a darker text value. */
export const STUDIO_ACCENTS: Record<
  StudioCuratedAccentId,
  { name: string } & ModePair
> = {
  ink: {
    name: 'Ink',
    light: { fill: '#1d1d1f', label: '#ffffff', text: '#1d1d1f' },
    dark: { fill: '#f2f2f4', label: '#111113', text: '#f2f2f4' },
  },
  blue: {
    name: 'Blue',
    light: { fill: '#0a5bd3', label: '#ffffff', text: '#0a5bd3' },
    dark: { fill: '#7ab0ff', label: '#0e1116', text: '#7ab0ff' },
  },
  lagoon: {
    name: 'Lagoon',
    light: { fill: '#00707a', label: '#ffffff', text: '#00707a' },
    dark: { fill: '#4fd1d9', label: '#0e1116', text: '#4fd1d9' },
  },
  green: {
    name: 'Green',
    light: { fill: '#0b7a4b', label: '#ffffff', text: '#0b7a4b' },
    dark: { fill: '#5fd49a', label: '#0e1116', text: '#5fd49a' },
  },
  violet: {
    name: 'Violet',
    light: { fill: '#6b3fd0', label: '#ffffff', text: '#6b3fd0' },
    dark: { fill: '#b49bff', label: '#0e1116', text: '#b49bff' },
  },
  rose: {
    name: 'Rose',
    light: { fill: '#b8235f', label: '#ffffff', text: '#b8235f' },
    dark: { fill: '#ff8db8', label: '#0e1116', text: '#ff8db8' },
  },
  coral: {
    name: 'Coral',
    light: { fill: '#c4362b', label: '#ffffff', text: '#c4362b' },
    dark: { fill: '#ff8a7a', label: '#0e1116', text: '#ff8a7a' },
  },
  amber: {
    name: 'Amber',
    light: { fill: '#f2b12e', label: '#1a1300', text: '#8a5800' },
    dark: { fill: '#f5c25a', label: '#1a1300', text: '#f5c25a' },
  },
};

/**
 * The default for `accent: null` (Classic, Creator): today's purple, and the canvas's derived dark
 * (§7.3, §9.1).
 */
export const CLASSIC_PURPLE: { name: 'TipMe purple' } & ModePair = {
  name: 'TipMe purple',
  light: { fill: '#7a32f9', label: '#ffffff', text: '#7a32f9' },
  dark: { fill: '#c8aeff', label: '#141210', text: '#c8aeff' },
};

export type StudioCoverType = 'yours' | 'gradient' | 'plain'; // 'yours' = the cover set in Settings

/**
 * The six every style has, plus the extras a style names in §9 (e.g. Clear's `track`, `thumb`).
 * `control` is the unselected chip border where `line` is under the 3:1 non-text minimum (§4.2):
 * the line's OKLCH hue and chroma, its lightness searched (darker in light, lighter in dark) to the
 * nearest value that reaches 3:1 on both `bg` and `card`.
 */
export interface StudioNeutrals {
  bg: Hex;
  card: Hex;
  el2: Hex;
  fg: Hex;
  fg2: Hex;
  line: Hex;
  [extra: string]: string;
}

export interface StudioStyle {
  id: StudioStyleId;
  name: string;
  /** §9 heading, shown in the Style tab. */
  mood: string;
  plan: 'free' | 'pro';
  /** null: Inter only. */
  displayFont: StudioFontId | null;
  /** null: TipMe purple (Classic, Creator). */
  defaultAccent: StudioCuratedAccentId | null;
  naturalMode: 'light' | 'dark';
  modes: readonly StudioMode[];
  /** UI order; 'yours' first. Signboard and Sprint offer no gradient. */
  covers: readonly StudioCoverType[];
  /** Stage, Horizon, Creator: a non-photo cover renders the gradient treatment. */
  needsPhoto: boolean;
  /** Where the fixed profile links sit on phone (§8). */
  linksAt: 'after-identity' | 'after-tip' | 'rail';
  neutrals: { light: StudioNeutrals; dark: StudioNeutrals };
}

const MODES: readonly StudioMode[] = ['light', 'dark', 'auto'];
const ALL_COVERS: readonly StudioCoverType[] = ['yours', 'gradient', 'plain'];
const NO_GRADIENT: readonly StudioCoverType[] = ['yours', 'plain'];

export const STUDIO_STYLES: Record<StudioStyleId, StudioStyle> = {
  // §9.1 and the canvas "Classic · phone" palette. Classic's line is the canvas `border`
  // (rgba(20,18,16,.14) light, rgba(255,255,255,.14) dark) composited over its canvas colour, so
  // it can be a hex; `border`, `hair` and `rule` keep the canvas's alpha values for CSS.
  classic: {
    id: 'classic',
    name: 'Classic',
    mood: 'Today’s TipMe page, unchanged',
    plan: 'free',
    displayFont: 'dm-serif-display',
    defaultAccent: null,
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    // Today's fixed order: person, links, words, tip panel.
    linksAt: 'after-identity',
    neutrals: {
      light: {
        bg: '#f3f2ee',
        card: '#fffefa',
        el2: '#eeede8',
        fg: '#000000',
        fg2: '#5d5a54',
        line: '#d4d3cf',
        base: '#ffffff',
        // tokens.css --text-tertiary (17 Nov 2026; the canvas's #77736b failed 4.5:1).
        fg3: '#6e6a63',
        border: 'rgba(20,18,16,.14)',
        hair: 'rgba(20,18,16,.09)',
        rule: 'rgba(20,18,16,.10)',
      },
      dark: {
        bg: '#141210',
        card: '#1e1b18',
        el2: '#2a2622',
        fg: '#f3f2ee',
        fg2: '#c9c4ba',
        line: '#353331',
        base: '#2a2622',
        fg3: '#a39e94',
        border: 'rgba(255,255,255,.14)',
        hair: 'rgba(255,255,255,.10)',
        rule: 'rgba(255,255,255,.12)',
      },
    },
  },
  clear: {
    id: 'clear',
    name: 'Clear',
    mood: 'Quiet, bright, precise',
    plan: 'free',
    displayFont: null,
    defaultAccent: 'blue',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#f5f5f7',
        card: '#ffffff',
        el2: '#ececf0',
        fg: '#1d1d1f',
        fg2: '#6e6e73',
        line: '#e3e3e8',
        control: '#8e8d92',
        track: '#e8e8ed',
        thumb: '#ffffff',
      },
      dark: {
        bg: '#111113',
        card: '#1c1c1e',
        el2: '#2a2a2e',
        fg: '#f5f5f7',
        fg2: '#a1a1a6',
        line: '#2e2e33',
        control: '#66676c',
        track: '#1c1c1e',
        thumb: '#3a3a3f',
      },
    },
  },
  journal: {
    id: 'journal',
    name: 'Journal',
    mood: 'A well-set magazine column',
    plan: 'free',
    displayFont: 'source-serif-4',
    defaultAccent: 'green',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#ffffff',
        card: '#ffffff',
        el2: '#f4f2ef',
        fg: '#1c1b1a',
        fg2: '#686460',
        line: '#e4e1dc',
        control: '#979490',
      },
      dark: {
        bg: '#141413',
        card: '#1d1c1a',
        el2: '#262522',
        fg: '#edebe8',
        fg2: '#a8a39d',
        line: '#2f2d2a',
        control: '#696763',
      },
    },
  },
  stage: {
    id: 'stage',
    name: 'Stage',
    mood: 'House lights down, spotlight up',
    plan: 'pro',
    displayFont: null,
    defaultAccent: 'violet',
    naturalMode: 'dark',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: true,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#f2f2f4',
        card: '#ffffff',
        el2: '#e8e8ec',
        fg: '#16161a',
        fg2: '#64646c',
        line: '#dedee3',
        control: '#8c8b90',
        chip: '#ffffff',
        // The desktop Tip card's chips (canvas StageDesktop: --chip: var(--chipIn)).
        chipIn: '#f2f2f4',
        scrimEnd: 'rgba(8,8,10,.86)',
      },
      dark: {
        bg: '#0f0f12',
        card: '#1a1a1f',
        el2: '#25252b',
        fg: '#f4f4f6',
        fg2: '#a3a3ad',
        line: '#2c2c33',
        control: '#65656d',
        chip: '#1a1a1f',
        chipIn: '#25252b',
        scrimEnd: '#0f0f12',
      },
    },
  },
  signboard: {
    id: 'signboard',
    name: 'Signboard',
    mood: 'Sign-painter confidence',
    plan: 'pro',
    displayFont: 'unbounded',
    defaultAccent: 'amber',
    naturalMode: 'light',
    modes: MODES,
    covers: NO_GRADIENT,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#faf8f3',
        card: '#ffffff',
        el2: '#f1ede3',
        fg: '#17150f',
        fg2: '#5e584c',
        line: '#17150f',
        ink: '#17150f',
        shadow: '#17150f',
      },
      dark: {
        bg: '#14130f',
        card: '#1f1d18',
        el2: '#2a2721',
        fg: '#f3f0e8',
        fg2: '#ada697',
        line: '#cfc8b8',
        ink: '#cfc8b8',
        shadow: '#000000',
      },
    },
  },
  sprint: {
    id: 'sprint',
    name: 'Sprint',
    mood: 'Fast, bold, all-caps energy',
    plan: 'pro',
    displayFont: 'anton',
    defaultAccent: 'ink',
    naturalMode: 'light',
    modes: MODES,
    covers: NO_GRADIENT,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#ffffff',
        card: '#f5f5f5',
        el2: '#ededed',
        fg: '#111111',
        fg2: '#6b6b6d',
        line: '#e2e2e2',
        control: '#8e8e8e',
      },
      dark: {
        bg: '#121212',
        card: '#1e1e1e',
        el2: '#2a2a2a',
        fg: '#f5f5f5',
        fg2: '#a8a8aa',
        line: '#2e2e2e',
        control: '#696868',
      },
    },
  },
  tiles: {
    id: 'tiles',
    name: 'Tiles',
    mood: 'A tidy desk of things you made',
    plan: 'pro',
    displayFont: null,
    defaultAccent: 'rose',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#eeeef1',
        card: '#ffffff',
        el2: '#f4f4f6',
        fg: '#1d1d1f',
        fg2: '#6a6a70',
        line: '#e3e3e8',
        shadow: '0 1px 2px rgba(20,20,30,.05), 0 6px 16px rgba(20,20,30,.05)',
      },
      dark: {
        bg: '#0f0f11',
        card: '#1c1c1f',
        el2: '#26262a',
        fg: '#f5f5f7',
        fg2: '#a1a1a8',
        line: '#2c2c31',
        shadow: 'none',
      },
    },
  },
  linen: {
    id: 'linen',
    name: 'Linen',
    mood: 'Morning light on paper',
    plan: 'free',
    displayFont: 'linen-serif',
    defaultAccent: 'coral',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#f6f1e8',
        card: '#fffdf8',
        el2: '#efe8db',
        fg: '#2b2520',
        fg2: '#6a5f55',
        line: '#e3d9c8',
        control: '#948a7b',
        mat: '#fffdf8',
      },
      dark: {
        bg: '#1a1613',
        card: '#24201b',
        el2: '#2e2923',
        fg: '#f1eadf',
        fg2: '#aea293',
        line: '#3a332b',
        control: '#716961',
        mat: '#2e2923',
      },
    },
  },
  horizon: {
    id: 'horizon',
    name: 'Horizon',
    mood: 'One image, a quiet name',
    plan: 'pro',
    displayFont: null,
    defaultAccent: 'lagoon',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: true,
    linksAt: 'after-tip',
    neutrals: {
      light: {
        bg: '#ffffff',
        card: '#f4f4f4',
        el2: '#eaeaea',
        fg: '#171a20',
        fg2: '#5c5e62',
        line: '#e2e2e2',
        control: '#8e8d8e',
      },
      dark: {
        bg: '#111214',
        card: '#1c1d20',
        el2: '#27282c',
        fg: '#f2f3f5',
        fg2: '#a4a7ad',
        line: '#2d2e32',
        control: '#66686c',
      },
    },
  },
  // Addendum §7.1 and §5.2. Every surface sits inside the photo-accent envelope (§5.2; the
  // contracts test asserts it). `control` is the chip border, 3:1 on bg and card.
  creator: {
    id: 'creator',
    name: 'Creator',
    mood: 'Bold, personal, made to be shared',
    plan: 'pro',
    displayFont: null,
    // null: TipMe purple (§6.1).
    defaultAccent: null,
    naturalMode: 'dark',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: true,
    // The icon row under the bio (§7.4).
    linksAt: 'after-identity',
    neutrals: {
      light: {
        bg: '#f7f5fc',
        card: '#ffffff',
        el2: '#eeeaf6',
        fg: '#17131f',
        fg2: '#5f5970',
        line: '#e2ddec',
        control: '#8f889e',
      },
      dark: {
        bg: '#0e0b16',
        card: '#1a1626',
        el2: '#262033',
        fg: '#f5f3fa',
        fg2: '#aba5ba',
        line: '#2e2840',
        control: '#6e6780',
      },
    },
  },
  // Addendum §7.2 and §5.2. `card` is the card rising over the cover; `row` the link rows and
  // chips inside it (3:1 for `control` on it too).
  professional: {
    id: 'professional',
    name: 'Professional',
    mood: 'Clean, composed, easy to trust',
    plan: 'pro',
    displayFont: null,
    defaultAccent: 'ink',
    naturalMode: 'light',
    modes: MODES,
    covers: ALL_COVERS,
    needsPhoto: false,
    linksAt: 'after-identity',
    neutrals: {
      light: {
        bg: '#f2efea',
        card: '#faf8f4',
        el2: '#ece8e1',
        fg: '#16151a',
        fg2: '#5e5b63',
        line: '#e4dfd6',
        control: '#8a857d',
        row: '#ffffff',
      },
      dark: {
        bg: '#0f0f11',
        card: '#18181b',
        el2: '#2a2a2f',
        fg: '#f4f4f6',
        fg2: '#a6a6ae',
        line: '#2e2e33',
        control: '#6c6c74',
        row: '#202024',
      },
    },
  },
};

export const STUDIO_FREE_STYLES: readonly StudioStyleId[] =
  STUDIO_STYLE_IDS.filter((id) => STUDIO_STYLES[id].plan === 'free');

/** The stored photo accent as read (`photoAccentOf`): its values, or its curated fallback. */
type PhotoAccent = PhotoAccentValues | PhotoAccentFailed;

/**
 * The accent values a page uses. `null` is the style's default (TipMe purple on Classic and
 * Creator).
 * `'photo'` takes the photo's values, or the curated accent it fell back to (§6 step 5); without
 * a photo accent (none computed yet, or the avatar was removed) it is the default too, so a page
 * always renders with a tested accent.
 */
export function accentValues(
  style: StudioStyleId,
  accent: StudioAccentId | null,
  mode: 'light' | 'dark',
  photo?: PhotoAccent | null,
): StudioAccentValues {
  if (accent === 'photo' && photo)
    return 'failed' in photo
      ? STUDIO_ACCENTS[photo.fallback][mode]
      : photo[mode];
  const id =
    accent && accent !== 'photo' ? accent : STUDIO_STYLES[style].defaultAccent;
  return id ? STUDIO_ACCENTS[id][mode] : CLASSIC_PURPLE[mode];
}

/** `color-mix(in oklab, a p, b)`, computed here so the result is a hex the contrast test can prove. */
function mixOklab(a: Hex, p: number, b: Hex): Hex {
  const lab = (h: Hex) => {
    const { l, c, h: hue } = hexToOklch(h);
    const r = (hue * Math.PI) / 180;
    return [l, c * Math.cos(r), c * Math.sin(r)] as const;
  };
  const x = lab(a);
  const y = lab(b);
  const [l, A, B] = [0, 1, 2].map((i) => x[i]! * p + y[i]! * (1 - p)) as [
    number,
    number,
    number,
  ];
  return oklchToHex({
    l,
    c: Math.hypot(A, B),
    h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
  });
}

/**
 * Journal and Linen's selected chip: a tint of the accent fill on `bg` (§9.3 note, builder's call
 * on the mix, "must look like the board for Green"). 6% gives the board's light `#f1f7f3` within
 * one unit. The board's dark `#1a2620` is no exact OKLab mix; 10% is the nearest (`#1c241e`, two
 * units), where 6% would be `#191d1a`, barely tinted.
 */
const CHIP_ON_STYLES: readonly StudioStyleId[] = ['journal', 'linen'];
const CHIP_ON_MIX = { light: 0.06, dark: 0.1 } as const;
const chipOn = (acc: Hex, bg: Hex, mode: 'light' | 'dark') =>
  mixOklab(acc, CHIP_ON_MIX[mode], bg);

/**
 * Tiles' focus ring inside the Tip tile (chips and the Tip sit on `acc`): `accLabel`, not
 * `accText`. Served as the `tileFocus` token; the CSS draws in-tile focus rings with it.
 */
export const STUDIO_TILES_TILE_FOCUS = (a: StudioAccentValues): Hex => a.label;

/**
 * Tiles' unselected chip ring: `color-mix(in srgb, accLabel 64%, acc)`. The canvas drew 45%, which
 * measures 2.17–2.96 on `acc`; 64% is the smallest whole percent reaching 3:1 (§4.2 control
 * borders) for every accent in both modes (lowest: Coral light, 3.05).
 */
export const STUDIO_TILES_RING_MIX = 0.64;
const tilesRing = (a: StudioAccentValues) =>
  blend(a.label, STUDIO_TILES_RING_MIX, a.fill);

/**
 * Creator's Tip (addendum §6.1): the accent's light pair in both modes, so the dark page keeps the
 * saturated button with its light label, already proven at 4.5:1. Except where the light pair is
 * Ink's (near-black, 1.16:1 on Creator's dark bg): there the dark pair. Compared by value, so a
 * photo accent stored as failed with Ink as its fallback takes the exception too.
 */
export function studioDeep(
  light: StudioAccentValues,
  dark: StudioAccentValues,
  mode: 'light' | 'dark',
): { fill: Hex; label: Hex } {
  const pair = mode === 'dark' && isInk(light, 'light') ? dark : light;
  return { fill: pair.fill, label: pair.label };
}

/** Whether these are Ink's values in this mode: the one test for the Tip's Ink exception. */
const isInk = (v: { fill: Hex; label: Hex }, mode: 'light' | 'dark') =>
  v.fill === STUDIO_ACCENTS.ink[mode].fill &&
  v.label === STUDIO_ACCENTS.ink[mode].label;

/**
 * The OKLCH lightness the Tip's vertical sheen drops at its lower end (addendum §6.1: 0 to 0.06,
 * builder's call). 0.04 is a visible sheen with room under the cap; the board may tune it. Both
 * ends keep `deepLabel` at 4.5:1, proven in `studioContrastPairs` (Amber and Ink dark, the dark
 * labels, are the ends it narrows).
 */
export const STUDIO_DEEP_SHEEN = 0.04;
const sheenEnd = (fill: Hex): Hex => {
  const { l, c, h } = hexToOklch(fill);
  return oklchToHex({ l: l - STUDIO_DEEP_SHEEN, c, h });
};

/**
 * The opacity of the Tip's second line ("Give, tip or appreciate") over `deep`. Ruling P2 of the
 * Creator plan: full opacity, because 85% measured under 4.5:1 for Green and Coral; its pair is
 * proven at this value, so any later change is proven too.
 */
const SECOND_LINE_OPACITY = 1;

/**
 * Ruling S-R2 (owner, 28 Nov: every design passes contrast and visibility): the Tip keeps 3:1
 * against the page at its weakest point (WCAG 1.4.11), which the sheen's darker end can't on its
 * own. So the button carries a 1 px edge (`deepEdge`): the fill itself wherever the fill reaches
 * 3:1 on `bg` (an edge in the button's own colour, so the look is unchanged), else the fill's hue
 * and chroma at the nearest lightness that does, away from the page (lighter in dark, darker in
 * light). Contrast with the page only grows that way, so a bisection finds it.
 */
export function studioTipEdge(fill: Hex, bg: Hex, mode: 'light' | 'dark'): Hex {
  const ok = (h: Hex) => contrastRatio(h, bg) >= 3;
  if (ok(fill)) return fill;
  const { l, c, h } = hexToOklch(fill);
  const at = (x: number) => oklchToHex({ l: x, c, h });
  let near = l; // fails
  let far = mode === 'dark' ? 1 : 0; // white or black: passes on every Studio page
  for (let i = 0; i < 20; i += 1) {
    const mid = (near + far) / 2;
    if (ok(at(mid))) far = mid;
    else near = mid;
  }
  return at(far);
}

export interface StudioContrastPair {
  name: string;
  fg: Hex;
  bg: Hex;
  min: 3 | 4.5;
}

/**
 * Every pair a style draws with these accent values in this mode (§4.2): text 4.5, non-text UI 3.
 * The design check and the exhaustive test both run these.
 *
 * `tip` is Creator's Tip pair in this mode (`studioDeep`), for a caller that knows both modes'
 * values (the exhaustive test). Without it, the light pass proves the light pair and the dark pass
 * proves it only for Ink's values, so a one-mode caller (the photo-accent search) never proves a
 * pair the page doesn't draw (addendum §6.1).
 */
export function studioContrastPairs(
  style: StudioStyleId,
  accent: StudioAccentValues,
  mode: 'light' | 'dark',
  tip?: { fill: Hex; label: Hex },
): StudioContrastPair[] {
  const n = STUDIO_STYLES[style].neutrals[mode];
  const { fill: acc, label: accLabel, text: accText } = accent;
  const pairs: StudioContrastPair[] = [
    { name: 'fg on bg', fg: n.fg, bg: n.bg, min: 4.5 },
    { name: 'fg on card', fg: n.fg, bg: n.card, min: 4.5 },
    { name: 'fg2 on bg', fg: n.fg2, bg: n.bg, min: 4.5 },
    { name: 'fg2 on card', fg: n.fg2, bg: n.card, min: 4.5 },
    // el2 is every style's hover, pressed and recessed surface, and text sits on it.
    { name: 'fg on el2', fg: n.fg, bg: n.el2, min: 4.5 },
    { name: 'accText on bg', fg: accText, bg: n.bg, min: 4.5 },
    { name: 'accText on card', fg: accText, bg: n.card, min: 4.5 },
    { name: 'accLabel on acc (Tip)', fg: accLabel, bg: acc, min: 4.5 },
    { name: 'focus ring (accText) on bg', fg: accText, bg: n.bg, min: 3 },
    { name: 'focus ring (accText) on card', fg: accText, bg: n.card, min: 3 },
  ];
  const add = (name: string, fg: Hex, bg: Hex, min: 3 | 4.5) =>
    pairs.push({ name, fg, bg, min });
  // A style that names a tertiary text colour sets text in it on all three surfaces.
  if (n.fg3)
    for (const bg of [n.bg, n.card, n.el2])
      add(
        `fg3 on ${bg === n.bg ? 'bg' : bg === n.card ? 'card' : 'el2'}`,
        n.fg3 as Hex,
        bg,
        4.5,
      );
  // Unselected chips sit on bg (Linen's in the card, Stage's desktop in a card): prove both.
  const chipBorder = (border: Hex) => {
    add('unselected chip border on bg', border, n.bg, 3);
    add('unselected chip border on card', border, n.card, 3);
  };

  switch (style) {
    case 'classic': {
      // No unselected-key border pair: Classic keeps today's keys byte for byte (§9.1), and they
      // are raised by fill, gloss and shadow, not by a border.
      add('selected key label on fill', accLabel, acc, 4.5);
      // Link text sits on every Classic surface: canvas, raised, recessed and base (dark: base
      // is recessed).
      const surfaces = [...new Set([n.bg, n.card, n.el2, n.base as Hex])];
      for (const s of surfaces) add(`link (accText) on ${s}`, accText, s, 4.5);
      break;
    }
    case 'clear':
      // The segmented track is the control; its edge is drawn in `control`.
      chipBorder(n.control as Hex);
      add('segment label (fg) on track', n.fg, n.track as Hex, 4.5);
      add('accText on thumb', accText, n.thumb as Hex, 4.5);
      break;
    case 'journal':
    case 'linen': {
      chipBorder(n.control as Hex);
      const on = chipOn(acc, n.bg, mode);
      // The selected chip: its label is fg, its 1.5 px border is accText (non-text, §4.2).
      add('selected chip label (fg) on chipOn', n.fg, on, 4.5);
      add('selected chip border (accText) on chipOn', accText, on, 3);
      break;
    }
    case 'stage':
      chipBorder(n.control as Hex);
      // Phone chips sit on `chip`; the desktop Tip card's on `chipIn`.
      for (const [name, surface] of [
        ['chip', n.chip],
        ['chipIn', n.chipIn],
      ] as const) {
        add(`chip label (fg) on ${name}`, n.fg, surface as Hex, 4.5);
        add(`selected ring (accText) on ${name}`, accText, surface as Hex, 3);
      }
      break;
    case 'signboard':
      chipBorder(n.ink as Hex);
      add('selected chip (bg) on ink', n.bg, n.ink as Hex, 4.5);
      add('band text (accLabel) on acc', accLabel, acc, 4.5);
      break;
    case 'sprint':
      chipBorder(n.control as Hex);
      add('selected chip (accLabel) on acc', accLabel, acc, 4.5);
      break;
    case 'tiles':
      // Chips and the Tip sit inside the acc tile, where accText would be ~1:1 on acc.
      add(
        'focus ring inside the Tip tile',
        STUDIO_TILES_TILE_FOCUS(accent),
        acc,
        3,
      );
      add('Tip and selected chip (acc) on accLabel', acc, accLabel, 4.5);
      add('chip label (accLabel) on acc', accLabel, acc, 4.5);
      add(
        'unselected chip border (accLabel 64%) on acc',
        tilesRing(accent),
        acc,
        3,
      );
      break;
    case 'horizon':
      chipBorder(n.control as Hex);
      add('selected ring (accText) on bg', accText, n.bg, 3);
      break;
    case 'creator': {
      chipBorder(n.control as Hex);
      // Chips sit on card; the icon row's badges on el2 circles (addendum §7.1).
      add('chip label (fg) on card', n.fg, n.card, 4.5);
      add('selected ring (accText) on card', accText, n.card, 3);
      add('icon badge (fg) on el2', n.fg, n.el2, 4.5);
      // A row's sub (fg2) on its el2 hover (§7.1).
      add('fg2 on el2', n.fg2, n.el2, 4.5);
      // The Tip's pair: the caller's (both modes known), else this mode's values where they are
      // the pair drawn (the light pass, or Ink's in dark: studioDeep).
      const deep =
        tip ??
        (mode === 'light' || isInk(accent, 'dark')
          ? { fill: acc, label: accLabel }
          : null);
      if (deep) {
        const second = blend(deep.label, SECOND_LINE_OPACITY, deep.fill);
        for (const [end, bg] of [
          ['', deep.fill],
          [' (sheen end)', sheenEnd(deep.fill)],
        ] as const) {
          add(`deepLabel on deep${end}`, deep.label, bg, 4.5);
          add(`second line on deep${end}`, second, bg, 4.5);
        }
        // Ruling S-R2: the button's edge against the page, its weakest point (non-text, 3:1).
        add(
          'Tip edge (deepEdge) on bg',
          studioTipEdge(deep.fill, n.bg, mode),
          n.bg,
          3,
        );
      }
      break;
    }
    case 'professional': {
      const row = n.row as Hex;
      chipBorder(n.control as Hex);
      // Link rows and chips sit on `row` inside the card (addendum §7.2).
      add('fg on row', n.fg, row, 4.5);
      add('fg2 on row', n.fg2, row, 4.5);
      add('accText on row', accText, row, 4.5);
      add('unselected chip border on row', n.control as Hex, row, 3);
      add('selected border (accText) on row', accText, row, 3);
      add('icon badge (fg) on el2', n.fg, n.el2, 4.5);
      // A row's sub (fg2) on its el2 hover (§7.2).
      add('fg2 on el2', n.fg2, n.el2, 4.5);
      break;
    }
  }
  return pairs;
}

/** CSS custom properties without the `--studio-` prefix; every key is `[a-zA-Z0-9]+`. */
export type StudioTokenMap = Record<string, string>;

/**
 * Both modes' tokens for a page: the style's neutrals (extras included), the accent's three
 * values as `acc`, `accLabel` and `accText`, `bar` (bg at 85%), and the derived tokens a style
 * names in §9 (`chipOn` for Journal and Linen, Stage's `glow`, Tiles' `tileFocus`), and Creator's
 * Tip (`deep`, `deepEnd` the sheen's lower end, `deepLabel`, `deepEdge` its 1 px edge; addendum
 * §6.1, ruling S-R2).
 */
export function studioTokens(
  style: StudioStyleId,
  accent: StudioAccentId | null,
  photo?: PhotoAccent | null,
): { light: StudioTokenMap; dark: StudioTokenMap } {
  const forMode = (mode: 'light' | 'dark'): StudioTokenMap => {
    const n = STUDIO_STYLES[style].neutrals[mode];
    const a = accentValues(style, accent, mode, photo);
    const t: StudioTokenMap = {
      ...n,
      acc: a.fill,
      accLabel: a.label,
      accText: a.text,
      bar: `${n.bg}d9`,
    };
    if (CHIP_ON_STYLES.includes(style)) t.chipOn = chipOn(a.fill, n.bg, mode);
    if (style === 'tiles') t.tileFocus = STUDIO_TILES_TILE_FOCUS(a);
    if (style === 'stage') t.glow = mode === 'dark' ? a.fill : 'none';
    if (style === 'creator') {
      const deep = studioDeep(
        accentValues(style, accent, 'light', photo),
        accentValues(style, accent, 'dark', photo),
        mode,
      );
      t.deep = deep.fill;
      t.deepEnd = sheenEnd(deep.fill);
      t.deepLabel = deep.label;
      t.deepEdge = studioTipEdge(deep.fill, n.bg, mode);
    }
    return t;
  };
  return { light: forMode('light'), dark: forMode('dark') };
}
