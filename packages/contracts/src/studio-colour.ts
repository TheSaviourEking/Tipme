/**
 * Page Studio colour maths: `#rrggbb` ⇄ OKLCH, WCAG 2.x contrast and alpha blending. The styles'
 * neutrals, accents and photo-accent sampling are built on these, and the contrast tests prove them.
 * (The v1 palette engine, which derived a page's colours from brand colours, was retired in PR 4b.)
 * Output is hex, never `oklch()`, so the contrast arithmetic is exact.
 */

export type Hex = `#${string}`;
export type StudioMode = 'light' | 'dark' | 'auto';

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export const AA = { body: 4.5, large: 3, ui: 3 } as const;

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
