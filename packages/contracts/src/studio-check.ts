/**
 * The Page Studio design check (plan 2026-11-12-page-studio, Task 4). One implementation, run by
 * the editor on every edit, by the API on every save and by publishing as the gate: a page with
 * any issue can't be published, and there is no "publish anyway", for staff too (owner ruling 12).
 *
 * Every issue comes with fixes. A fix is a pure document transform (`applyStudioFix`), and is only
 * offered after the check has tried it: it must remove its issue and add none. Fixes that need the
 * person's input (a new photo, a new link, a description, new words) are listed but change nothing.
 * Corrections the renderer makes by itself are reported as notices ("Fixed for you").
 */
import {
  deriveStudioPalette,
  hexToOklch,
  paletteFailures,
  type Hex,
  type StudioColourNote,
  type StudioPalette,
} from './studio-colour.js';
import {
  STUDIO_BLOCK_VARIANTS,
  studioDocumentSchema,
  type StudioBlock,
  type StudioColumns,
  type StudioDocument,
  type StudioRow,
} from './studio-document.js';
import {
  BLOCK_MIN_WIDTH,
  STUDIO_BREAKPOINTS,
  STUDIO_GRID,
  STUDIO_SPANS,
  cellWidthAt,
  mainWidth,
  tileWidth,
} from './studio-layout.js';
import {
  STUDIO_FONTS,
  fontsOk,
  studioTypeScale,
  type StudioFont,
  type StudioTextRole,
} from './studio-type.js';

/** Bump when a rule changes; published pages that now fail fall back to the standard page. */
export const DESIGN_CHECK_VERSION = 1;

export type StudioRuleId =
  | 'contrast'
  | 'contrast-on-photo'
  | 'phone-fit'
  | 'long-word'
  | 'fonts'
  | 'heading-order'
  | 'crowded'
  | 'photo-resolution'
  | 'photo-alt'
  | 'page-weight'
  | 'empty-block'
  | 'broken-video'
  | 'missing-links';

/** Rules that can block publishing, in the order issues are listed. */
export const STUDIO_ERROR_RULES = [
  'contrast',
  'phone-fit',
  'long-word',
  'fonts',
  'heading-order',
  'crowded',
  'photo-resolution',
  'photo-alt',
  'page-weight',
  'empty-block',
  'broken-video',
] as const satisfies readonly StudioRuleId[];

/** Rules about the whole page: two issues of one of these are the same issue wherever they point. */
const PAGE_RULES: readonly StudioRuleId[] = [
  'contrast',
  'fonts',
  'page-weight',
];

export interface StudioCheckContext {
  /** Server facts per stored image: source size and bytes per rendition ("square-960"). */
  images: Record<
    string,
    { width: number; height: number; bytes: { [rendition: string]: number } }
  >;
  /** By URL. 'unknown' never fails: the server's video check is best effort. */
  videos: Record<string, 'ok' | 'gone' | 'unknown'>;
  profile: { bio: boolean; links: number };
}

export interface StudioFix {
  id: string;
  /** The board's button copy, e.g. "Make the photo smaller". */
  label: string;
}

export interface StudioIssue {
  rule: StudioRuleId;
  severity: 'error';
  /** The row (empty for the whole page), the block, and for a crowded column its index. */
  at: { row: string; block?: string; cell?: number };
  message: string;
  detail?: string;
  fixes: StudioFix[];
}

/** "Fixed for you": corrections the renderer applies. */
export interface StudioNotice {
  rule: StudioRuleId;
  message: string;
}

export interface StudioCheckResult {
  version: number;
  issues: StudioIssue[];
  notices: StudioNotice[];
  passing: StudioRuleId[];
  /** Estimated first load on a 390px phone, in bytes. */
  weightBytes: number;
}

export const STUDIO_FIX_LABELS = {
  'suggested-colours': 'Use the suggested colours',
  'list-style': 'Use the list style',
  'narrower-style': 'Use a narrower style',
  'two-columns': 'Use 2 columns',
  'smaller-heading': 'Use a smaller heading',
  'edit-text': 'Edit the text',
  'one-font': 'Use one font for both',
  'main-heading': 'Make it a main heading',
  'split-row': 'Split into two rows',
  'more-space': 'Use more space',
  'smaller-slot': 'Make the photo smaller',
  'plain-background': 'Use a plain background',
  'replace-photo': 'Replace photo',
  'mark-decorative': 'Mark as decorative',
  'add-description': 'Add a description',
  'one-family': 'Use one font family',
  'move-lower': 'Move the gallery lower',
  'remove-block': 'Remove the block',
  'remove-video': 'Remove the video',
  'change-link': 'Change the link',
} as const;
type FixId = keyof typeof STUDIO_FIX_LABELS;

/** Fixes that open a field or a picker in the editor; applying one changes nothing. */
export const STUDIO_FIX_NEEDS_INPUT: readonly string[] = [
  'replace-photo',
  'change-link',
  'add-description',
  'edit-text',
];

/** The first-load budget on a phone (owner ruling 6) and the model behind the estimate. */
export const STUDIO_WEIGHT = {
  budget: 1_500_000,
  /** HTML, CSS and script of a page, before fonts and photos. */
  base: 180_000,
  phone: 390,
  screen: 844,
  screens: 1.5,
  /** Cover, name, photo and tip block come first on a phone. */
  aboveStudio: 880,
  dpr: 2,
} as const;

export const RENDITION_WIDTHS = [480, 960, 1440] as const;
const ASPECT = { square: 1, wide: 16 / 9, tall: 4 / 5, strip: 3.73 } as const;
type Shape = keyof typeof ASPECT;

// ---------------------------------------------------------------------------------------------
// Helpers

const fontById = (id: string): StudioFont =>
  STUDIO_FONTS.find((f) => f.id === id) ?? (STUDIO_FONTS[0] as StudioFont);

/** Whether `text` has a required letter the font can't draw (so it is set in the text font). */
const lacks = (font: StudioFont, text: string) =>
  font.missing.length > 0 &&
  [...text].some((c) => font.missing.includes(c.codePointAt(0) ?? 0));

/** The font a heading-font text is actually set in. */
function headingFontFor(doc: StudioDocument, text: string): StudioFont {
  const heading = fontById(doc.fonts.heading);
  return lacks(heading, text) ? fontById(doc.fonts.body) : heading;
}

/** px of a clamp(MINpx, Arem + Bvw, MAXpx) size at a screen width. */
function sizeAt(css: string, viewport: number): number {
  const m = /^clamp\(([\d.]+)px, ([\d.]+)rem \+ ([\d.]+)vw, ([\d.]+)px\)$/.exec(
    css,
  );
  if (!m) return 16;
  const [min, rem, vw, max] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return Math.min(max, Math.max(min, rem * 16 + (vw * viewport) / 100));
}

/**
 * Whether text in this role counts as large for WCAG (≥24px, or ≥18.66px and bold) at its
 * smallest size. The renderer colours text with a LARGE_ONLY accent only when this is true.
 */
export function studioLargeText(
  doc: Pick<StudioDocument, 'scale' | 'fonts'>,
  role: 'display' | 'h2' | 'h3',
): boolean {
  const min = studioTypeScale(doc.scale)[role].min;
  return (
    min >= 24 ||
    (min >= 18.66 && fontById(doc.fonts.heading).headingWeight >= 700)
  );
}

/** A plain colour word for the one-sentence notes. */
export function studioColourName(hex: Hex): string {
  const { l, c, h } = hexToOklch(hex);
  if (c < 0.03) return 'grey';
  if (h >= 15 && h < 115 && l < 0.5) return 'brown';
  if (h < 15 || h >= 345) return 'pink';
  if (h < 45) return 'red';
  if (h < 75) return 'orange';
  if (h < 115) return 'yellow';
  if (h < 170) return 'green';
  if (h < 215) return 'teal';
  if (h < 270) return 'blue';
  if (h < 320) return 'purple';
  return 'pink';
}

const palettes = new Map<
  string,
  { palette: StudioPalette; failures: string[] }
>();
function derived(brand: StudioDocument['brand']) {
  const key = brand.join();
  let p = palettes.get(key);
  if (!p) {
    const palette = deriveStudioPalette(brand);
    p = { palette, failures: paletteFailures(palette) };
    if (palettes.size > 200) palettes.clear();
    palettes.set(key, p);
  }
  return p;
}
const paletteOf = (brand: StudioDocument['brand']) => derived(brand).palette;

const scales = new Map<string, ReturnType<typeof studioTypeScale>>();
function scaleOf(step: StudioDocument['scale']) {
  let s = scales.get(step);
  if (!s) scales.set(step, (s = studioTypeScale(step)));
  return s;
}

/** A deep copy of a document (plain JSON data, so cheaper than structuredClone). */
function copy(doc: StudioDocument): StudioDocument {
  return {
    ...doc,
    brand: [...doc.brand] as StudioDocument['brand'],
    fonts: { ...doc.fonts },
    rows: doc.rows.map((row) => ({
      ...row,
      background:
        typeof row.background === 'object'
          ? { ...row.background }
          : row.background,
      cells: row.cells.map((cell) =>
        cell.map((b) => {
          if (b.kind === 'gallery')
            return { ...b, images: b.images.map((i) => ({ ...i })) };
          if (b.kind === 'services')
            return { ...b, items: b.items.map((i) => ({ ...i })) };
          if (b.kind === 'events')
            return { ...b, items: b.items.map((i) => ({ ...i })) };
          return { ...b };
        }),
      ),
    })),
  };
}

/** 1020 → "1,020" (toLocaleString is slow, and this runs for every fix tried). */
const number = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const snippet = (s: string) =>
  [...s].length > 24 ? `${[...s].slice(0, 24).join('')}…` : s;

interface Located {
  row: StudioRow;
  r: number;
  c: number;
  k: number;
  block: StudioBlock;
}

function* blocksOf(doc: StudioDocument): Generator<Located> {
  for (const [r, row] of doc.rows.entries())
    for (const [c, cell] of row.cells.entries())
      for (const [k, block] of cell.entries()) yield { row, r, c, k, block };
}

/** Same rule at the same place (page-wide rules: same rule). */
export function sameIssue(
  a: Pick<StudioIssue, 'rule' | 'at'>,
  b: Pick<StudioIssue, 'rule' | 'at'>,
): boolean {
  if (a.rule !== b.rule) return false;
  if (PAGE_RULES.includes(a.rule)) return true;
  return (
    a.at.row === b.at.row &&
    a.at.block === b.at.block &&
    a.at.cell === b.at.cell
  );
}

// ---------------------------------------------------------------------------------------------
// Page weight

function blockHeight(
  b: StudioBlock,
  w: number,
  ctx: StudioCheckContext,
): number {
  const lines = (text: string, perChar: number) =>
    Math.max(1, Math.ceil(([...text].length * perChar) / w));
  switch (b.kind) {
    case 'text':
      if (b.variant === 'heading') return lines(b.text, 13) * 32 + 8;
      if (b.variant === 'lead') return lines(b.text, 10.6) * 30 + 8;
      return (
        lines(b.text, 8.5) * 26 + (b.text.split('\n\n').length - 1) * 16 + 8
      );
    case 'quote':
      return lines(b.text, 10.6) * 30 + 32;
    case 'about':
      return 80;
    case 'links':
      return b.variant === 'buttons' ? 56 * Math.max(1, ctx.profile.links) : 56;
    case 'services':
      return (b.variant === 'list' ? 56 : 112) * b.items.length + 8;
    case 'events':
      return (b.variant === 'list' ? 64 : 120) * b.items.length + 8;
    case 'video':
      return (w * 9) / 16 + (b.caption ? 24 : 0);
    case 'photo':
      return (
        w /
          (b.variant === 'wide'
            ? ASPECT.wide
            : b.variant === 'tall'
              ? ASPECT.tall
              : 1) +
        (b.caption ? 24 : 0)
      );
    case 'gallery': {
      const tile = tileWidth(w, b.variant, false) + STUDIO_GRID.tileGap;
      if (b.variant === 'strip') return tile;
      if (b.variant === 'mosaic')
        return b.images.length
          ? tileWidth(w, 'mosaic', true) +
              Math.ceil((b.images.length - 1) / 2) * tile
          : 0;
      return Math.ceil(b.images.length / 2) * tile;
    }
    case 'supporters':
      return 80;
  }
}

function renditionBytes(
  ctx: StudioCheckContext,
  imageId: string,
  shape: Shape,
  cssWidth: number,
): number {
  const need = cssWidth * STUDIO_WEIGHT.dpr;
  const width = RENDITION_WIDTHS.find((w) => w >= need) ?? 1440;
  const bytes = ctx.images[imageId]?.bytes ?? {};
  const exact = bytes[`${shape}-${width}`];
  if (exact !== undefined) return exact;
  // Not made (renditions are never upscaled): the largest smaller one is what loads.
  const smaller = RENDITION_WIDTHS.filter((w) => w < width)
    .map((w) => bytes[`${shape}-${w}`])
    .filter((b): b is number => b !== undefined);
  return smaller.length
    ? (smaller[smaller.length - 1] as number)
    : Math.round(width * (width / ASPECT[shape]) * 0.08);
}

/** Estimated first load on a 390px phone, and the row holding the heaviest photo in it. */
export function studioWeight(
  doc: StudioDocument,
  ctx: StudioCheckContext,
): { bytes: number; heaviestRow: string } {
  const heading = fontById(doc.fonts.heading);
  const body = fontById(doc.fonts.body);
  const fileBytes = (f: StudioFont) =>
    f.files.reduce((s, file) => s + file.bytes, 0);
  let bytes =
    STUDIO_WEIGHT.base +
    fileBytes(heading) +
    (body.id === heading.id ? 0 : fileBytes(body));
  const fold =
    STUDIO_WEIGHT.screen * STUDIO_WEIGHT.screens - STUDIO_WEIGHT.aboveStudio;
  const v = STUDIO_WEIGHT.phone;
  const spacing = { s: 16, m: 24, l: 40 } as const;
  let y = 0;
  let heaviest = { bytes: 0, row: '' };
  const count = (row: StudioRow, add: number) => {
    bytes += add;
    if (add > heaviest.bytes) heaviest = { bytes: add, row: row.id };
  };
  for (const row of doc.rows) {
    if (y >= fold) break;
    if (typeof row.background === 'object')
      count(
        row,
        renditionBytes(ctx, row.background.photo, 'strip', mainWidth(v)),
      );
    y += spacing[row.spacing];
    for (const [c, cell] of row.cells.entries()) {
      const w = cellWidthAt(row, c, v);
      for (const b of cell) {
        if (y < fold) {
          if (b.kind === 'photo')
            count(
              row,
              renditionBytes(
                ctx,
                b.imageId,
                b.variant === 'wide'
                  ? 'wide'
                  : b.variant === 'tall'
                    ? 'tall'
                    : 'square',
                w,
              ),
            );
          if (b.kind === 'gallery') {
            const tile = tileWidth(w, b.variant, false) + STUDIO_GRID.tileGap;
            b.images.forEach((image, i) => {
              const top =
                b.variant === 'strip'
                  ? 0
                  : b.variant === 'mosaic'
                    ? i === 0
                      ? 0
                      : tileWidth(w, 'mosaic', true) +
                        Math.floor((i - 1) / 2) * tile
                    : Math.floor(i / 2) * tile;
              if (y + top < fold)
                count(
                  row,
                  renditionBytes(
                    ctx,
                    image.imageId,
                    'square',
                    tileWidth(w, b.variant, i === 0),
                  ),
                );
            });
          }
        }
        y += blockHeight(b, w, ctx) + 16;
      }
    }
    y += spacing[row.spacing];
  }
  return { bytes, heaviestRow: heaviest.row };
}

/** The widest screen the model sizes for: photos are judged at their spot here. */
const WIDEST = STUDIO_GRID.maxWidth;

// ---------------------------------------------------------------------------------------------
// The rules

/** A narrower variant of the same block, where there is one. */
const NARROWER: Partial<Record<string, string>> = {
  'services:cards': 'list',
  'events:cards': 'list',
  'gallery:mosaic': 'grid',
  'gallery:strip': 'grid',
  'links:buttons': 'icons',
  'quote:band': 'plain',
  'photo:wide': 'square',
  'text:lead': 'paragraph',
};

const KIND_WORDS: Record<StudioBlock['kind'], string> = {
  text: 'Text',
  photo: 'A photo',
  gallery: 'A gallery',
  video: 'A video',
  services: 'Services',
  events: 'Events',
  links: 'Links',
  quote: 'A quote',
  about: 'About',
  supporters: 'The supporter wall',
};

interface Raw {
  rule: StudioRuleId;
  at: StudioIssue['at'];
  message: string;
  detail?: string;
  fixes: FixId[];
}

function weightOf(b: StudioBlock, ctx: StudioCheckContext): number {
  switch (b.kind) {
    case 'photo':
    case 'video':
    case 'supporters':
      return 1;
    case 'gallery':
      return 1 + 0.25 * b.images.length;
    case 'services':
    case 'events':
      return 1 + 0.2 * b.items.length;
    case 'links':
      return 1 + 0.2 * ctx.profile.links;
    default:
      return 0.5;
  }
}

/** Text a block shows, its type role, and whether it is set in the heading font. */
function textOf(
  b: StudioBlock,
): { text: string; role: StudioTextRole; heading: boolean } | null {
  if (b.kind === 'text') {
    if (b.variant === 'heading')
      return { text: b.text, role: b.level === 3 ? 'h3' : 'h2', heading: true };
    if (b.variant === 'lead')
      return { text: b.text, role: 'h3', heading: false };
    return { text: b.text, role: 'body', heading: false };
  }
  if (b.kind === 'quote') return { text: b.text, role: 'h3', heading: true };
  return null;
}

function isEmpty(b: StudioBlock, ctx: StudioCheckContext): boolean {
  switch (b.kind) {
    case 'gallery':
      return b.images.length === 0;
    case 'services':
    case 'events':
      return b.items.length === 0;
    case 'links':
      return ctx.profile.links === 0;
    case 'about':
      return !ctx.profile.bio;
    case 'text':
    case 'quote':
      return b.text.length === 0;
    default:
      return false;
  }
}

function rawIssues(doc: StudioDocument, ctx: StudioCheckContext): Raw[] {
  const out: Raw[] = [];
  const rowName = (r: number) => `Row ${r + 1}`;

  // contrast: unreachable by construction (the engine derives every pair); kept as the fail-safe.
  const failures = derived(doc.brand).failures;
  if (failures.length)
    out.push({
      rule: 'contrast',
      at: { row: '' },
      message: 'Some colours are hard to read',
      detail: failures[0],
      fixes: ['suggested-colours'],
    });

  // phone-fit: every block fits its cell at every width.
  for (const { row, r, c, block } of blocksOf(doc)) {
    const min = BLOCK_MIN_WIDTH[`${block.kind}:${block.variant}`] ?? 0;
    let worst: { v: number; w: number } | null = null;
    for (const v of STUDIO_BREAKPOINTS) {
      const w = cellWidthAt(row, c, v);
      if (w < min && (!worst || w < worst.w)) worst = { v, w };
    }
    if (worst) {
      const fixes: FixId[] = [];
      const narrower = NARROWER[`${block.kind}:${block.variant}`];
      if (narrower)
        fixes.push(narrower === 'list' ? 'list-style' : 'narrower-style');
      if (row.columns !== '1' && row.columns !== '1-1')
        fixes.push('two-columns');
      fixes.push('remove-block');
      out.push({
        rule: 'phone-fit',
        at: { row: row.id, block: block.id },
        message: `${KIND_WORDS[block.kind]} is too wide for its column`,
        detail: `${rowName(r)}: it needs ${min} px, but on a ${worst.v} px screen its column is ${number(worst.w)} px.`,
        fixes,
      });
    }
  }

  // long-word: a word that would break in the middle.
  for (const { row, r, c, block } of blocksOf(doc)) {
    const t = textOf(block);
    if (!t || !t.text) continue;
    const font = t.heading
      ? headingFontFor(doc, t.text)
      : fontById(doc.fonts.body);
    const perEm =
      (font.metrics.avgAdvance + font.metrics.maxWordAdvance) /
      2 /
      font.metrics.unitsPerEm;
    const longest = t.text
      .split(/\s+/)
      .reduce((a, w) => ([...w].length > [...a].length ? w : a), '');
    const css = scaleOf(doc.scale)[t.role].css;
    const bad = STUDIO_BREAKPOINTS.find(
      (v) =>
        [...longest].length * perEm * sizeAt(css, v) > cellWidthAt(row, c, v),
    );
    if (bad === undefined) continue;
    const fixes: FixId[] = [];
    if (
      (block.kind === 'text' &&
        block.variant === 'heading' &&
        block.level !== 3) ||
      (block.kind === 'text' && block.variant === 'lead')
    )
      fixes.push('smaller-heading');
    fixes.push('edit-text');
    out.push({
      rule: 'long-word',
      at: { row: row.id, block: block.id },
      message: 'A long word won’t fit',
      detail: `${rowName(r)}: “${snippet(longest)}” would break in the middle on a ${bad} px screen.`,
      fixes,
    });
  }

  // fonts: unreachable through the schema; kept as the fail-safe.
  if (!fontsOk(doc.fonts.heading, doc.fonts.body))
    out.push({
      rule: 'fonts',
      at: { row: '' },
      message: 'These fonts can’t be used together',
      fixes: ['one-font'],
    });

  // heading-order: the first heading on the page is a main heading.
  for (const { row, r, block } of blocksOf(doc)) {
    if (block.kind !== 'text' || block.variant !== 'heading') continue;
    if (block.level === 3)
      out.push({
        rule: 'heading-order',
        at: { row: row.id, block: block.id },
        message: 'Headings are out of order',
        detail: `${rowName(r)}: the first heading on your page is a small one.`,
        fixes: ['main-heading'],
      });
    break;
  }

  // crowded: too much in one column, or two colour rows pressed together.
  for (const [r, row] of doc.rows.entries()) {
    row.cells.forEach((cell, c) => {
      const fraction = (STUDIO_SPANS[row.columns][c] ?? 12) / 12;
      const weight = cell.reduce((s, b) => s + weightOf(b, ctx), 0);
      if (weight / fraction > 6)
        out.push({
          rule: 'crowded',
          at: { row: row.id, cell: c },
          message: `${rowName(r)} is crowded`,
          detail: 'There’s too much in one column to read comfortably.',
          fixes: ['split-row'],
        });
    });
    const before = doc.rows[r - 1];
    const band = (x: StudioRow) =>
      x.background === 'colour' || x.background === 'second';
    if (
      before &&
      band(before) &&
      band(row) &&
      (before.spacing === 's' || row.spacing === 's')
    )
      out.push({
        rule: 'crowded',
        at: { row: row.id },
        message: `${rowName(r - 1)} and ${rowName(r).toLowerCase()} run together`,
        detail: 'Two colour rows with little space between them read as one.',
        fixes: ['more-space'],
      });
  }

  // photo-resolution: a source smaller than its biggest spot (1440 px screen, after the crop).
  const usable = (imageId: string, shape: Shape) => {
    const f = ctx.images[imageId];
    return f ? Math.floor(Math.min(f.width, f.height * ASPECT[shape])) : 0;
  };
  for (const [r, row] of doc.rows.entries()) {
    if (typeof row.background !== 'object') continue;
    const slot = Math.round(mainWidth(WIDEST));
    const has = usable(row.background.photo, 'strip');
    if (has < slot)
      out.push({
        rule: 'photo-resolution',
        at: { row: row.id },
        message: 'A photo will look blurry',
        detail: `${rowName(r)}, background photo: ${number(has)} pixels wide, shown at up to ${number(slot)}.`,
        fixes: ['plain-background', 'replace-photo'],
      });
  }
  for (const { row, r, c, block } of blocksOf(doc)) {
    const cell = cellWidthAt(row, c, WIDEST);
    const spots =
      block.kind === 'photo'
        ? [
            {
              imageId: block.imageId,
              shape: (block.variant === 'wide'
                ? 'wide'
                : block.variant === 'tall'
                  ? 'tall'
                  : 'square') as Shape,
              slot: cell,
              n: 0,
            },
          ]
        : block.kind === 'gallery'
          ? block.images.map((image, i) => ({
              imageId: image.imageId,
              shape: 'square' as Shape,
              slot: tileWidth(cell, block.variant, i === 0),
              n: i,
            }))
          : [];
    const blurry = spots.find(
      (s) => usable(s.imageId, s.shape) < Math.round(s.slot),
    );
    if (!blurry) continue;
    out.push({
      rule: 'photo-resolution',
      at: { row: row.id, block: block.id },
      message: 'A photo will look blurry',
      detail: `${rowName(r)}${block.kind === 'gallery' ? `, gallery photo ${blurry.n + 1}` : ''}: ${number(usable(blurry.imageId, blurry.shape))} pixels wide, shown at up to ${number(blurry.slot)}.`,
      fixes: ['smaller-slot', 'replace-photo'],
    });
  }

  // photo-alt: every photo is described or marked decorative.
  for (const { row, r, block } of blocksOf(doc)) {
    const missing =
      block.kind === 'photo'
        ? !block.decorative && block.alt === ''
        : block.kind === 'gallery' &&
          block.images.some((i) => !i.decorative && i.alt === '');
    if (missing)
      out.push({
        rule: 'photo-alt',
        at: { row: row.id, block: block.id },
        message: 'A photo has no description',
        detail: `${rowName(r)}: describe it for people who can’t see it, or mark it as decorative.`,
        fixes: ['mark-decorative', 'add-description'],
      });
  }

  // page-weight: first load on a phone within budget.
  const weight = studioWeight(doc, ctx);
  if (weight.bytes > STUDIO_WEIGHT.budget) {
    const fixes: FixId[] = [];
    if (doc.fonts.heading !== doc.fonts.body) fixes.push('one-family');
    fixes.push('move-lower');
    out.push({
      rule: 'page-weight',
      at: { row: weight.heaviestRow },
      message: 'Your page is too heavy for phones',
      detail: `First load on a phone: ${number(weight.bytes / 1000)} KB of 1.5 MB.`,
      fixes,
    });
  }

  // empty-block
  for (const { row, r, block } of blocksOf(doc))
    if (isEmpty(block, ctx))
      out.push({
        rule: 'empty-block',
        at: { row: row.id, block: block.id },
        message: `${KIND_WORDS[block.kind]} is empty`,
        detail: `${rowName(r)}: it would show nothing. Fill it in or remove it.`,
        fixes: ['remove-block'],
      });

  // broken-video
  const SITE = {
    youtube: 'YouTube',
    tiktok: 'TikTok',
    audiomack: 'Audiomack',
  } as const;
  for (const { row, r, block } of blocksOf(doc)) {
    if (block.kind !== 'video' || ctx.videos[block.url] !== 'gone') continue;
    const host = new URL(block.url).hostname;
    const site = host.includes('tiktok')
      ? SITE.tiktok
      : host.includes('audiomack')
        ? SITE.audiomack
        : SITE.youtube;
    out.push({
      rule: 'broken-video',
      at: { row: row.id, block: block.id },
      message: 'A video link doesn’t work',
      detail: `${rowName(r)}: ${site} says this video is private or removed.`,
      fixes: ['remove-video', 'change-link'],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Notices

function colourNotice(
  note: StudioColourNote,
  mode: 'light' | 'dark',
  doc: StudioDocument,
  palette: StudioPalette,
): string {
  const hex = doc.brand[note.colour] ?? doc.brand[0];
  const name = studioColourName(hex);
  const light = mode === 'light';
  if (note.code === 'NEUTRAL_FALLBACK')
    return `Your ${name} is very close to grey, so your page uses neutral shades with it.`;
  if (note.code === 'LARGE_ONLY')
    return `Your ${name} is too ${light ? 'light' : 'dark'} for small text on a ${mode} page. On the ${mode} page we use a ${light ? 'deeper' : 'lighter'} ${name}, ${note.textShade.toUpperCase()}, for links.`;
  const onButton = palette[mode].buttonText === '#000000' ? 'dark' : 'light';
  return `Your ${name} is too ${light ? 'light' : 'dark'} for text on a ${mode} page. We’ll use it for highlights and for buttons with ${onButton} text, and a ${light ? 'deeper' : 'lighter'} shade of it for links and headings. Your page will still look ${name}.`;
}

function notices(doc: StudioDocument, ctx: StudioCheckContext): StudioNotice[] {
  const out: StudioNotice[] = [];
  const palette = paletteOf(doc.brand);
  const modes =
    doc.mode === 'auto' ? (['light', 'dark'] as const) : ([doc.mode] as const);
  for (const mode of modes)
    for (const note of palette.notes[mode])
      out.push({
        rule: 'contrast',
        message: colourNotice(note, mode, doc, palette),
      });

  for (const [r, row] of doc.rows.entries())
    if (
      typeof row.background === 'object' &&
      row.cells.some((cell) =>
        cell.some(
          (b) =>
            b.kind !== 'photo' && b.kind !== 'gallery' && b.kind !== 'video',
        ),
      )
    )
      out.push({
        rule: 'contrast-on-photo',
        message: `Added a shade behind the words on the photo in row ${r + 1}, so they stay readable.`,
      });
  for (const { block } of blocksOf(doc))
    if (block.kind === 'photo' && block.caption)
      out.push({
        rule: 'contrast-on-photo',
        message: `Added a shade behind the caption on “${snippet(block.caption)}”, so the words stay readable on the photo.`,
      });

  const heading = fontById(doc.fonts.heading);
  for (const { block } of blocksOf(doc)) {
    const t = textOf(block);
    if (t?.heading && lacks(heading, t.text)) {
      out.push({
        rule: 'fonts',
        message: `Set in your text font: “${snippet(t.text)}” has a letter ${heading.name} doesn’t have.`,
      });
      break;
    }
  }

  if (
    [...blocksOf(doc)].some(({ block }) => block.kind === 'links') &&
    ctx.profile.links > 0
  )
    out.push({
      rule: 'missing-links',
      message:
        'Your Links block shows the social links on My page, so a link you remove there disappears here too.',
    });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Check and fixes

/** Whether applying `fix` removes `issue`, adds no issue, and keeps the document valid. */
function works(
  doc: StudioDocument,
  ctx: StudioCheckContext,
  issue: Raw,
  fix: FixId,
  before: Raw[],
): boolean {
  const next = applyFix(doc, issue, fix);
  if (!next || !studioDocumentSchema.safeParse(next).success) return false;
  const after = rawIssues(next, ctx);
  return (
    !after.some((a) => sameIssue(a, issue)) &&
    after.every((a) => before.some((b) => sameIssue(a, b)))
  );
}

function fixLabel(doc: StudioDocument, issue: Raw, fix: FixId): string {
  if (fix === 'list-style' || fix === 'narrower-style')
    return STUDIO_FIX_LABELS[fix];
  if (fix === 'move-lower') {
    const row = doc.rows.find((r) => r.id === issue.at.row);
    const gallery = row?.cells.some((cell) =>
      cell.some((b) => b.kind === 'gallery'),
    );
    return gallery ? STUDIO_FIX_LABELS['move-lower'] : 'Move the photo lower';
  }
  return STUDIO_FIX_LABELS[fix];
}

/**
 * Where each issue is, without trying any fix: the same issues `checkDesign` lists, at a fraction
 * of the cost. For counting and comparing (tests, a quick "N to fix"); never for showing fixes.
 */
export function studioIssueKeys(
  doc: StudioDocument,
  ctx: StudioCheckContext,
): Pick<StudioIssue, 'rule' | 'at'>[] {
  return rawIssues(doc, ctx).map(({ rule, at }) => ({ rule, at }));
}

/**
 * Checks a document against every rule with the server's facts. Pure and deterministic: the
 * editor, the API and publishing get the same answer for the same document and facts.
 */
export function checkDesign(
  doc: StudioDocument,
  ctx: StudioCheckContext,
): StudioCheckResult {
  const raw = rawIssues(doc, ctx);
  const issues: StudioIssue[] = raw.map((issue) => ({
    rule: issue.rule,
    severity: 'error',
    at: issue.at,
    message: issue.message,
    ...(issue.detail ? { detail: issue.detail } : {}),
    fixes: issue.fixes
      .filter(
        (f) =>
          STUDIO_FIX_NEEDS_INPUT.includes(f) || works(doc, ctx, issue, f, raw),
      )
      .map((f) => ({ id: f, label: fixLabel(doc, issue, f) })),
  }));
  return {
    version: DESIGN_CHECK_VERSION,
    issues,
    notices: notices(doc, ctx),
    passing: STUDIO_ERROR_RULES.filter(
      (rule) => !issues.some((i) => i.rule === rule),
    ),
    weightBytes: studioWeight(doc, ctx).bytes,
  };
}

function freshRowId(doc: StudioDocument, base: string): string {
  const used = new Set([
    ...doc.rows.map((r) => r.id),
    ...[...blocksOf(doc)].map((l) => l.block.id),
  ]);
  for (let k = 0; ; k += 1) {
    const id = `${base.slice(0, 6)}${k.toString(36).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
}

const SMALLER_SLOT: Partial<
  Record<StudioColumns, Partial<Record<number, StudioColumns>>>
> = {
  '2-1': { 0: '1-1' },
  '1-2': { 1: '1-1' },
  '1-1': { 0: '1-2', 1: '2-1' },
  '1': { 0: '1-1' },
};

/**
 * Applies one fix to a copy of the document. Pure. A fix that needs the person's input, or that
 * no longer applies, returns an unchanged copy.
 */
export function applyStudioFix(
  doc: StudioDocument,
  issue: Pick<StudioIssue, 'rule' | 'at'>,
  fixId: string,
): StudioDocument {
  return applyFix(doc, issue, fixId) ?? copy(doc);
}

/** The fixed copy, or null when the fix needs input or no longer applies. */
function applyFix(
  doc: StudioDocument,
  issue: Pick<StudioIssue, 'rule' | 'at'>,
  fixId: string,
): StudioDocument | null {
  const d = copy(doc);
  const r = d.rows.findIndex((row) => row.id === issue.at.row);
  const row = d.rows[r];
  const found = issue.at.block
    ? [...blocksOf(d)].find((l) => l.block.id === issue.at.block)
    : undefined;
  const insertAfter = (at: number, blocks: StudioBlock[], from: StudioRow) =>
    d.rows.splice(at + 1, 0, {
      id: freshRowId(d, from.id),
      columns: '1',
      spacing: from.spacing,
      background:
        typeof from.background === 'object' ? 'page' : from.background,
      cells: [blocks],
    });

  const no = null;
  switch (fixId as FixId) {
    case 'suggested-colours':
      if (d.brand.length === 1 && d.brand[0] === '#7a32f9') return no;
      d.brand = ['#7a32f9'];
      return d;
    case 'one-font':
    case 'one-family':
      if (d.fonts.heading === d.fonts.body) return no;
      d.fonts.heading = d.fonts.body;
      return d;
    case 'remove-block':
    case 'remove-video':
      if (!found) return no;
      found.row.cells[found.c]?.splice(found.k, 1);
      return d;
    case 'list-style':
    case 'narrower-style': {
      const narrower =
        found && NARROWER[`${found.block.kind}:${found.block.variant}`];
      if (!found || !narrower) return no;
      (found.block as { variant: string }).variant = narrower;
      return d;
    }
    case 'two-columns': {
      const target = found?.row ?? row;
      const at = found?.r ?? r;
      if (!target) return no;
      if (target.columns === '2-1' || target.columns === '1-2')
        target.columns = '1-1';
      else if (target.columns === '1-1-1') {
        target.columns = '1-1';
        insertAfter(at, target.cells.pop() ?? [], target);
      } else return no;
      return d;
    }
    case 'smaller-slot': {
      const next = found && SMALLER_SLOT[found.row.columns]?.[found.c];
      if (!found || !next) return no;
      if (found.row.columns === '1') found.row.cells.push([]);
      found.row.columns = next;
      return d;
    }
    case 'plain-background':
      if (!row || row.background === 'page') return no;
      row.background = 'page';
      return d;
    case 'smaller-heading':
      if (found?.block.kind !== 'text') return no;
      if (found.block.variant === 'heading' && found.block.level === 2)
        found.block.level = 3;
      else if (found.block.variant === 'lead')
        found.block.variant = 'paragraph';
      else return no;
      return d;
    case 'main-heading':
      if (
        found?.block.kind !== 'text' ||
        found.block.variant !== 'heading' ||
        found.block.level === 2
      )
        return no;
      found.block.level = 2;
      return d;
    case 'split-row': {
      const cell =
        issue.at.cell !== undefined ? row?.cells[issue.at.cell] : undefined;
      if (!row || !cell || cell.length < 2) return no;
      insertAfter(r, [cell.pop() as StudioBlock], row);
      return d;
    }
    case 'more-space': {
      const before = d.rows[r - 1];
      if (row?.spacing !== 's' && before?.spacing !== 's') return no;
      if (row?.spacing === 's') row.spacing = 'm';
      if (before?.spacing === 's') before.spacing = 'm';
      return d;
    }
    case 'mark-decorative': {
      let changed = false;
      if (
        found?.block.kind === 'photo' &&
        found.block.alt === '' &&
        !found.block.decorative
      ) {
        found.block.decorative = true;
        changed = true;
      }
      if (found?.block.kind === 'gallery')
        for (const image of found.block.images)
          if (image.alt === '' && !image.decorative) {
            image.decorative = true;
            changed = true;
          }
      return changed ? d : no;
    }
    case 'move-lower':
      if (!row || r >= d.rows.length - 1) return no;
      d.rows.splice(r, 2, d.rows[r + 1] as StudioRow, row);
      return d;
    default:
      return no;
  }
}

/** Every block kind a document can hold, for the editor's "Add a block" list. */
export const STUDIO_BLOCK_KINDS = Object.keys(
  STUDIO_BLOCK_VARIANTS,
) as StudioBlock['kind'][];
