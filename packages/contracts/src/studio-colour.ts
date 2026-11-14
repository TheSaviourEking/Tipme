/**
 * Page Studio colour engine (plan 2026-11-12-page-studio, Task 1).
 *
 * A Pro page picks one or two brand colours as `#rrggbb`. This module turns them into every colour
 * the page uses, for a light and a dark page, so that each text/background pair meets WCAG 2.x AA
 * by construction: text-like colours are found by searching OKLCH lightness at the brand hue until
 * the contrast passes against every surface they sit on. Brand colours never reach CSS directly;
 * only these derived tokens do. Output is hex, never `oklch()`, so the contrast arithmetic is exact.
 */

export type Hex = `#${string}`;
export type StudioMode = 'light' | 'dark' | 'auto';

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export const AA = { body: 4.5, large: 3, ui: 3 } as const;

/** Text on a photo always sits on this shade; its worst case (a white photo) is #616161, 6.19:1. */
export const STUDIO_SCRIM = {
  colour: '#000000',
  opacity: 0.62,
  text: '#ffffff',
} as const;

export interface StudioTokens {
  /** Surfaces. `line` is decorative only; `control` (borders that identify controls) is ≥3:1. */
  page: Hex;
  card: Hex;
  tint: Hex;
  line: Hex;
  control: Hex;
  /** Text on page, card and tint, each ≥4.5:1. */
  text: Hex;
  muted: Hex;
  heading: Hex;
  link: Hex;
  /** The brand colour as used for text; `accentLarge` means only ≥24px (or ≥18.66px bold) text. */
  accent: Hex;
  accentLarge: boolean;
  /** Buttons are filled with the brand colour; `buttonText` is black or white, ≥4.5:1 on it. */
  button: Hex;
  buttonText: Hex;
  /**
   * Focus ring, ≥3:1 on page, card and tint. Drawn with an offset so it sits on the surface; inside
   * a button the ring's inner edge uses `buttonText`, which is ≥4.5:1 on the fill (see `paletteFailures`).
   */
  focus: Hex;
  /** The "Colour" row background and its text (≥4.5:1). */
  band: Hex;
  bandText: Hex;
  /** The optional second colour, same rules: a fill, the text on it, and a text shade for surfaces. */
  second?: { fill: Hex; onFill: Hex; text: Hex };
}

export type StudioColourNote =
  | { code: 'ACCENT_ONLY'; colour: 0 | 1; textShade: Hex }
  | { code: 'LARGE_ONLY'; colour: 0 | 1; textShade: Hex }
  | { code: 'NEUTRAL_FALLBACK'; colour: 0 | 1 };

export interface StudioPalette {
  light: StudioTokens;
  dark: StudioTokens;
  notes: { light: StudioColourNote[]; dark: StudioColourNote[] };
}

const HEX = /^#[0-9a-f]{6}$/;

export function isHex(s: string): s is Hex {
  return HEX.test(s);
}

// ---------------------------------------------------------------------------------------------
// sRGB ⇄ OKLCH (Björn Ottosson's OKLab matrices)

const toLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function channels(h: Hex): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function hexToOklch(h: Hex): Oklch {
  const [r, g, b] = channels(h).map(toLinear) as [number, number, number];
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  const hue = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h: hue };
}

/** Linear sRGB for an OKLCH colour, possibly outside [0, 1]. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const EPS = 1e-6;
const inGamut = (rgb: readonly number[]) =>
  rgb.every((v) => v >= -EPS && v <= 1 + EPS);

function linearToHex(rgb: readonly number[]): Hex {
  return `#${rgb
    .map((v) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** OKLCH → hex. Out-of-gamut colours keep their lightness and hue and lose chroma until they fit. */
export function oklchToHex(colour: Oklch): Hex {
  const l = Math.min(1, Math.max(0, colour.l));
  const exact = oklchToLinear({ l, c: colour.c, h: colour.h });
  if (inGamut(exact)) return linearToHex(exact);
  let lo = 0;
  let hi = colour.c;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear({ l, c: mid, h: colour.h }))) lo = mid;
    else hi = mid;
  }
  return linearToHex(oklchToLinear({ l, c: lo, h: colour.h }));
}

// ---------------------------------------------------------------------------------------------
// WCAG 2.x contrast

function luminance(h: Hex): number {
  const [r, g, b] = channels(h).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Hex, b: Hex): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `over` at `opacity` composited on `under` (sRGB-space alpha blending, as browsers do). */
export function blend(over: Hex, opacity: number, under: Hex): Hex {
  const a = channels(over);
  const b = channels(under);
  return `#${a
    .map((v, i) =>
      Math.round((v * opacity + (b[i] ?? 0) * (1 - opacity)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

// ---------------------------------------------------------------------------------------------
// The engine

const passesAll = (fg: Hex, against: readonly Hex[], min: number) =>
  against.every((bg) => contrastRatio(fg, bg) >= min);

/**
 * The shade of hue `h` (chroma `c`, reduced to fit the gamut) nearest to the surfaces that still
 * passes `min` against every one of them. Searches lightness towards black on a light page and
 * towards white on a dark page. Every candidate is tested as the hex it will be served as, and the
 * end of the search (black or white) passes ≥4.58:1 against any surface, so it always terminates
 * with a passing colour.
 */
function findShade(
  h: number,
  c: number,
  against: readonly Hex[],
  min: number,
  direction: 'dark' | 'light',
): Hex {
  const end = direction === 'dark' ? 0 : 1;
  let pass = end;
  let fail = 1 - end;
  let best = oklchToHex({ l: end, c, h });
  if (!passesAll(best, against, min)) {
    best = direction === 'dark' ? '#000000' : '#ffffff';
    if (!passesAll(best, against, min))
      throw new Error(`no shade reaches ${min}:1`); // unreachable for the surfaces used here
    return best;
  }
  for (let i = 0; i < 28; i += 1) {
    const mid = (pass + fail) / 2;
    const candidate = oklchToHex({ l: mid, c, h });
    if (passesAll(candidate, against, min)) {
      pass = mid;
      best = candidate;
    } else fail = mid;
  }
  return best;
}

/** Black or white, whichever reads better on `fill` (one of them is always ≥4.58:1). */
function onFill(fill: Hex): Hex {
  return contrastRatio('#000000', fill) >= contrastRatio('#ffffff', fill)
    ? '#000000'
    : '#ffffff';
}

/** A fill whose black-or-white text passes AA body; sRGB makes this the brand itself, but it is asserted. */
function readableFill(fill: Hex, h: number, c: number): Hex {
  if (contrastRatio(onFill(fill), fill) >= AA.body) return fill;
  return findShade(h, c, ['#ffffff'], AA.body, 'dark');
}

/** Below this chroma a brand colour reads as grey: shades are neutral and its hue is not kept. */
const NEUTRAL_CHROMA = 0.02;

interface Brand {
  hex: Hex;
  h: number;
  c: number;
  neutral: boolean;
}

function brandOf(hex: Hex): Brand {
  const { c, h } = hexToOklch(hex);
  const neutral = c < NEUTRAL_CHROMA;
  return { hex, h: neutral ? 0 : h, c: neutral ? 0 : c, neutral };
}

const SURFACES = {
  light: {
    page: [0.985, 0.012],
    card: [1, 0],
    tint: [0.955, 0.035],
    line: [0.88, 0.035],
  },
  dark: {
    page: [0.2, 0.04],
    card: [0.25, 0.04],
    tint: [0.29, 0.04],
    line: [0.36, 0.04],
  },
} as const;

function tokensFor(
  mode: 'light' | 'dark',
  brand: Brand,
  second: Brand | undefined,
): { tokens: StudioTokens; notes: StudioColourNote[] } {
  const s = SURFACES[mode];
  const surface = ([l, cap]: readonly [number, number]) =>
    oklchToHex({ l, c: Math.min(brand.c, cap), h: brand.h });
  const page = surface(s.page);
  const card = surface(s.card);
  const tint = surface(s.tint);
  const line = surface(s.line);
  const surfaces = [page, card, tint] as const;
  const toward = mode === 'light' ? 'dark' : 'light';
  const shade = (c: number, min: number, h = brand.h) =>
    findShade(h, c, surfaces, min, toward);

  const notes: StudioColourNote[] = [];
  const textOf = (b: Brand, index: 0 | 1) => {
    if (passesAll(b.hex, surfaces, AA.body))
      return { link: b.hex, accent: b.hex, accentLarge: false };
    const textShade = findShade(b.h, b.c, surfaces, AA.body, toward);
    if (index === 0 && passesAll(b.hex, surfaces, AA.large)) {
      notes.push({ code: 'LARGE_ONLY', colour: index, textShade });
      return { link: textShade, accent: b.hex, accentLarge: true };
    }
    notes.push({ code: 'ACCENT_ONLY', colour: index, textShade });
    return { link: textShade, accent: textShade, accentLarge: false };
  };

  const main = textOf(brand, 0);
  const button = readableFill(brand.hex, brand.h, brand.c);
  const tokens: StudioTokens = {
    page,
    card,
    tint,
    line,
    control: shade(Math.min(brand.c, 0.08), AA.ui),
    text: shade(Math.min(brand.c, 0.03), 7),
    muted: shade(Math.min(brand.c, 0.04), AA.body),
    heading: shade(brand.c, AA.body),
    link: main.link,
    accent: main.accent,
    accentLarge: main.accentLarge,
    button,
    buttonText: onFill(button),
    focus: shade(Math.min(brand.c, 0.12), AA.ui),
    band: button,
    bandText: onFill(button),
  };
  if (brand.neutral) notes.push({ code: 'NEUTRAL_FALLBACK', colour: 0 });

  if (second) {
    const fill = readableFill(second.hex, second.h, second.c);
    const text = textOf(second, 1).link;
    tokens.second = { fill, onFill: onFill(fill), text };
    if (second.neutral) notes.push({ code: 'NEUTRAL_FALLBACK', colour: 1 });
  }
  return { tokens, notes };
}

export function deriveStudioPalette(
  brand: readonly [Hex] | readonly [Hex, Hex],
): StudioPalette {
  for (const b of brand)
    if (!isHex(b)) throw new Error(`not a #rrggbb colour: ${b}`);
  const main = brandOf(brand[0]);
  const second = brand[1] ? brandOf(brand[1]) : undefined;
  const light = tokensFor('light', main, second);
  const dark = tokensFor('dark', main, second);
  return {
    light: light.tokens,
    dark: dark.tokens,
    notes: { light: light.notes, dark: dark.notes },
  };
}

/**
 * Every required pair that fails, as "dark muted on tint 4.31 < 4.5". Empty means the palette is
 * AA in both modes. The design check re-runs this on every save (fail-safe; the engine already
 * guarantees it).
 */
export function paletteFailures(p: StudioPalette): string[] {
  const failures: string[] = [];
  const need = (
    label: string,
    fg: Hex,
    bg: Hex,
    bgLabel: string,
    min: number,
  ) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio < min)
      failures.push(`${label} on ${bgLabel} ${ratio.toFixed(2)} < ${min}`);
  };
  for (const mode of ['light', 'dark'] as const) {
    const t = p[mode];
    const surfaces = { page: t.page, card: t.card, tint: t.tint };
    for (const [bgLabel, bg] of Object.entries(surfaces)) {
      for (const fg of ['text', 'muted', 'link', 'heading'] as const)
        need(`${mode} ${fg}`, t[fg], bg, bgLabel, AA.body);
      need(
        `${mode} accent`,
        t.accent,
        bg,
        bgLabel,
        t.accentLarge ? AA.large : AA.body,
      );
      need(`${mode} control`, t.control, bg, bgLabel, AA.ui);
      need(`${mode} focus`, t.focus, bg, bgLabel, AA.ui);
      if (t.second)
        need(`${mode} second.text`, t.second.text, bg, bgLabel, AA.body);
    }
    need(`${mode} buttonText`, t.buttonText, t.button, 'button', AA.body);
    need(`${mode} bandText`, t.bandText, t.band, 'band', AA.body);
    if (t.second)
      need(
        `${mode} second.onFill`,
        t.second.onFill,
        t.second.fill,
        'second.fill',
        AA.body,
      );
  }
  need(
    'scrim text',
    STUDIO_SCRIM.text,
    blend(STUDIO_SCRIM.colour, STUDIO_SCRIM.opacity, '#ffffff'),
    'white photo',
    AA.body,
  );
  return failures;
}
