/**
 * "From your photo" (spec 2026-11-17-page-studio-styles §6, §5.3): the Pro accent TipMe picks from
 * the person's profile photo. The API samples up to five dominant colours from the avatar; this
 * turns them into light and dark accent values that pass every pair all nine styles draw (the same
 * `studioContrastPairs` the exhaustive proof runs), or, when none can, a curated fallback. Pure and
 * deterministic: the same colours always give the same answer. Written only by the server; a page
 * never stores a colour of its own.
 */
import { z } from 'zod';
import {
  contrastRatio,
  hexToOklch,
  isHex,
  oklchToHex,
  type Hex,
} from './studio-colour.js';
import {
  STUDIO_ACCENTS,
  STUDIO_STYLE_IDS,
  studioContrastPairs,
  type StudioAccentValues,
  type StudioCuratedAccentId,
} from './studio-styles.js';

/** The values a page uses, light and dark. */
export interface PhotoAccentValues {
  light: StudioAccentValues;
  dark: StudioAccentValues;
}
/**
 * No sampled colour passed: the page uses this curated accent, and the editor says so.
 * `nothingSampled`: the photo gave no clear colour at all (a smooth gradient, say), so the editor
 * doesn't blame contrast.
 */
export interface PhotoAccentFailed {
  failed: true;
  fallback: StudioCuratedAccentId;
  nothingSampled?: true;
}
/**
 * What `page_studios.photo_accent` holds. Both kinds name the photo they came from
 * (`avatarVersion`), so a newer photo never inherits either.
 */
export type PhotoAccent =
  | ({ source: 'avatar'; avatarVersion: number } & PhotoAccentValues)
  | ({ avatarVersion: number } & PhotoAccentFailed);

/**
 * §6 step 3: the curated fill band (light L .45–.55, dark L .75–.82), chroma capped at .16; §6
 * step 2: anything under chroma .04 is a near-grey.
 */
export const PHOTO_ACCENT_BAND = {
  light: [0.45, 0.55],
  dark: [0.75, 0.82],
  chroma: 0.16,
  grey: 0.04,
} as const;

/**
 * §6 step 2, "low-chroma skin oranges" (builder's call on the numbers): hues 20°–90° under chroma
 * .13. Measured on the Monk scale 1–10 and warm-lit skin as photos show it, medium and deep skin
 * reaches C .124 (light skin stays under .11), so the cut leaves a margin for every skin tone
 * alike, and brown hair; a clearly orange, red or golden garment (C .147 and up) stays a candidate.
 */
const SKIN = { from: 20, to: 90, chroma: 0.13 } as const;

/** The labels §7.3 uses: white first in light, the dark labels first in dark. */
const LABELS: Record<'light' | 'dark', readonly Hex[]> = {
  light: ['#ffffff', '#1a1300', '#111113', '#0e1116'],
  dark: ['#0e1116', '#111113', '#1a1300', '#ffffff'],
};

/** At most this many colours are tried (§6 step 1). */
const MAX_CANDIDATES = 5;
/** The fill's lightness is tried at the clamped value, then in steps of .01 within the band. */
const FILL_STEP = 0.01;

type Mode = 'light' | 'dark';

// Not a colour any style uses: marks where the text value is drawn, so the text search proves
// exactly the pairs `studioContrastPairs` names, Classic's surfaces included.
const TEXT_PROBE: Hex = '#010203';

type Lab = [number, number, number];
const lab = (h: Hex): Lab => {
  const { l, c, h: hue } = hexToOklch(h);
  const r = (hue * Math.PI) / 180;
  return [l, c * Math.cos(r), c * Math.sin(r)];
};

/**
 * The curated accent nearest in OKLab to `colour`'s light fill; a near-grey is Ink (§7.1's rule,
 * which the v1 migration also uses).
 */
export function nearestCuratedAccent(colour: Hex): StudioCuratedAccentId {
  if (hexToOklch(colour).c < PHOTO_ACCENT_BAND.grey) return 'ink';
  const own = lab(colour);
  let best: StudioCuratedAccentId = 'ink';
  let bestDistance = Infinity;
  for (const id of Object.keys(STUDIO_ACCENTS) as StudioCuratedAccentId[]) {
    const other = lab(STUDIO_ACCENTS[id].light.fill);
    const d = Math.hypot(
      own[0] - other[0],
      own[1] - other[1],
      own[2] - other[2],
    );
    if (d < bestDistance) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

const isSkin = (c: number, h: number) =>
  c < SKIN.chroma && h >= SKIN.from && h <= SKIN.to;

const passes = (values: StudioAccentValues, mode: Mode) =>
  STUDIO_STYLE_IDS.every((style) =>
    studioContrastPairs(style, values, mode).every(
      (p) => contrastRatio(p.fg, p.bg) >= p.min,
    ),
  );

/**
 * §6 step 4: the fill itself when it already reaches every surface the text sits on; otherwise
 * the fill darkened (light) or lightened (dark) in OKLCH lightness, hue and chroma kept, to the
 * nearest value that does. Contrast against light surfaces only grows as the text darkens (and
 * against dark ones as it lightens), so a bisection finds it. Null when even the end of the
 * range fails.
 */
function textFor(fill: Hex, label: Hex, mode: Mode): Hex | null {
  const targets = STUDIO_STYLE_IDS.flatMap((style) =>
    studioContrastPairs(style, { fill, label, text: TEXT_PROBE }, mode).filter(
      (p) => p.fg === TEXT_PROBE,
    ),
  );
  const ok = (text: Hex) =>
    targets.every((p) => contrastRatio(text, p.bg) >= p.min);
  if (ok(fill)) return fill;
  const { l, c, h } = hexToOklch(fill);
  const end = mode === 'light' ? 0.15 : 0.97;
  const at = (x: number) => oklchToHex({ l: x, c, h });
  if (!ok(at(end))) return null;
  let near = l; // fails
  let far = end; // passes
  for (let i = 0; i < 20; i += 1) {
    const mid = (near + far) / 2;
    if (ok(at(mid))) far = mid;
    else near = mid;
  }
  return at(far);
}

/** One mode's values for a candidate (§6 steps 3–4), or null when nothing in the band passes. */
function valuesFor(colour: Hex, mode: Mode): StudioAccentValues | null {
  const { l, c, h } = hexToOklch(colour);
  const [lo, hi] = PHOTO_ACCENT_BAND[mode];
  const chroma = Math.min(c, PHOTO_ACCENT_BAND.chroma);
  const start = Math.min(hi, Math.max(lo, l));
  // The clamped lightness first, then towards more contrast with the label: darker in light
  // (white labels), lighter in dark (dark labels), never leaving the band (builder's call).
  const steps: number[] = [start];
  for (
    let x = mode === 'light' ? start - FILL_STEP : start + FILL_STEP;
    mode === 'light' ? x >= lo - 1e-9 : x <= hi + 1e-9;
    x += mode === 'light' ? -FILL_STEP : FILL_STEP
  )
    steps.push(x);
  for (const x of steps) {
    const fill = oklchToHex({ l: x, c: chroma, h });
    for (const label of LABELS[mode]) {
      if (contrastRatio(label, fill) < 4.5) continue;
      const text = textFor(fill, label, mode);
      if (!text) continue;
      const values = { fill, label, text };
      if (passes(values, mode)) return values;
    }
  }
  return null;
}

/**
 * §6 steps 2–6: the first candidate (most dominant first) that passes everything in both modes,
 * or `{ failed: true, fallback }` with the curated accent nearest the most dominant colour that
 * survived the grey and skin filters, or Ink when none did. A dropped colour never chooses it, so
 * a portrait's fallback never depends on the person's skin. Nothing to try at all is
 * `nothingSampled`.
 */
export function pickPhotoAccent(
  candidates: readonly Hex[],
): PhotoAccentValues | PhotoAccentFailed {
  const colours = candidates
    .filter((c): c is Hex => typeof c === 'string' && isHex(c.toLowerCase()))
    .map((c) => c.toLowerCase() as Hex)
    .slice(0, MAX_CANDIDATES);
  if (colours.length === 0)
    return { failed: true, fallback: 'ink', nothingSampled: true };
  let survivor: Hex | null = null;
  for (const colour of colours) {
    const { c, h } = hexToOklch(colour);
    if (c < PHOTO_ACCENT_BAND.grey || isSkin(c, h)) continue;
    survivor ??= colour;
    const light = valuesFor(colour, 'light');
    const dark = light && valuesFor(colour, 'dark');
    if (light && dark) return { light, dark };
  }
  return {
    failed: true,
    fallback: survivor ? nearestCuratedAccent(survivor) : 'ink',
  };
}

const hexSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/)
  .transform((s) => s as Hex);
const valuesSchema = z.strictObject({
  fill: hexSchema,
  label: hexSchema,
  text: hexSchema,
});
const curatedIds = Object.keys(STUDIO_ACCENTS) as [
  StudioCuratedAccentId,
  ...StudioCuratedAccentId[],
];

/** The stored column's shape; anything else reads as no photo accent. */
export const photoAccentSchema = z.union([
  z.strictObject({
    source: z.literal('avatar'),
    avatarVersion: z.number().int().min(0),
    light: valuesSchema,
    dark: valuesSchema,
  }),
  z.strictObject({
    failed: z.literal(true),
    fallback: z.enum(curatedIds),
    avatarVersion: z.number().int().min(0),
    nothingSampled: z.literal(true).optional(),
  }),
]);

/**
 * The stored photo accent as the page and the editor read it: only a valid value, and only for
 * the avatar it was made from (sampled values and fallbacks alike). No avatar, or a newer one, is null,
 * so a page never shows a stale accent: it shows the style's default until the new one is stored.
 */
export function photoAccentOf(
  stored: unknown,
  avatar: { avatarVersion: number } | null,
): PhotoAccentValues | PhotoAccentFailed | null {
  if (!avatar) return null;
  const parsed = photoAccentSchema.safeParse(stored);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.avatarVersion !== avatar.avatarVersion) return null;
  if ('failed' in value)
    return {
      failed: true,
      fallback: value.fallback,
      ...(value.nothingSampled ? { nothingSampled: true as const } : {}),
    };
  return { light: value.light, dark: value.dark };
}

/** The editor's sentence for a photo accent that fell back (§6 step 5, copy). */
export function photoAccentNotice(
  photo: PhotoAccentValues | PhotoAccentFailed | null,
): string | null {
  if (!photo || !('failed' in photo)) return null;
  if (photo.nothingSampled)
    return `We couldn't find a clear colour in your photo, so your page uses ${STUDIO_ACCENTS[photo.fallback].name}.`;
  return `Your photo's colours didn't pass our contrast check, so your page uses ${STUDIO_ACCENTS[photo.fallback].name}.`;
}
