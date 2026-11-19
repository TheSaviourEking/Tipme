/**
 * The Page Studio design check, version 3 (styles spec §5.5). One implementation for the editor,
 * the API and publishing, as in v1: any issue blocks publishing, and every issue comes with fixes.
 * A fix is a pure document transform (`applyStudioFix`), offered only after the check has tried it:
 * it must remove its issue and add none. Fixes that need the person (a new photo, new words, a
 * style choice) and links ("See Pro") are listed and change nothing.
 *
 * What changed from v1: the document has no rows, colours, fonts or variants, so the contrast,
 * fonts, phone-fit, crowded and heading-order rules are gone (the finite style set is proven in CI
 * instead); `pro-only` enforces the plan; `cover-photo`, `name-fallback` and `missing-links` are
 * notices; and photo slots and heading widths come from the style (`studioSlotWidth`).
 *
 * Copy follows the spec word for word. It never names the payment provider (it is "our payment
 * partner"), never implies regulatory approval, and the pronoun is "they". This file has no such
 * copy today; the web test `no-provider-names` scans it to keep it that way.
 */
import {
  type StudioBlock,
  type StudioBlockKind,
  type StudioDocument,
  STUDIO_PRO_BLOCKS,
} from './studio-document.js';
import {
  RENDITION_WIDTHS,
  STUDIO_FIX_LABELS,
  STUDIO_IMAGE_ASPECT,
  STUDIO_WEIGHT,
  type StudioCheckResult,
  type StudioFix,
  type StudioIssue,
  type StudioNotice,
  type StudioRuleId,
} from './studio-check.js';
import {
  CLASSIC_PURPLE,
  STUDIO_ACCENTS,
  STUDIO_STYLES,
  type StudioStyleId,
} from './studio-styles.js';
import { STUDIO_FONTS, type StudioFont } from './studio-type.js';

/** Bump when a rule changes; published pages that now fail fall back to the standard page. */
export const DESIGN_CHECK_VERSION = 3;

/** Rules that can block publishing, in the order issues are listed. */
export const STUDIO_ERROR_RULES_V3 = [
  'pro-only',
  'photo-resolution',
  'photo-alt',
  'empty-block',
  'broken-video',
  'page-weight',
  'long-word',
] as const satisfies readonly StudioRuleId[];

export interface StudioCheckContext {
  /** Server facts per stored image: source size and bytes of the stored file. */
  images: Record<string, { width: number; height: number; bytes: number }>;
  /** By URL. 'unknown' never fails: the server's video check is best effort. */
  videos: Record<string, 'ok' | 'gone' | 'unknown'>;
  /** `name` is the display name; `links` the number of saved profile links. */
  profile: { name: string; bio: boolean; links: number };
  plan: 'free' | 'pro';
  /** The cover set in Settings. */
  coverKind: 'photo' | 'design' | 'automatic' | 'animated' | 'none';
  hasAvatar: boolean;
}

export const STUDIO_FIX_LABELS_V3 = {
  'choose-free-style': 'Choose a free style',
  'use-default-accent': 'Use the style’s own colour',
  'see-pro': 'See Pro',
  'remove-block': STUDIO_FIX_LABELS['remove-block'],
  'remove-video': STUDIO_FIX_LABELS['remove-video'],
  'replace-photo': STUDIO_FIX_LABELS['replace-photo'],
  'mark-decorative': STUDIO_FIX_LABELS['mark-decorative'],
  'add-description': STUDIO_FIX_LABELS['add-description'],
  'change-link': STUDIO_FIX_LABELS['change-link'],
  'move-lower': STUDIO_FIX_LABELS['move-lower'],
  'shorter-heading': 'Use a shorter heading',
} as const;
type FixId = keyof typeof STUDIO_FIX_LABELS_V3;

/** Fixes that open a picker or a field in the editor; applying one changes nothing. */
export const STUDIO_FIX_NEEDS_INPUT_V3: readonly string[] = [
  'choose-free-style',
  'replace-photo',
  'add-description',
  'change-link',
  'shorter-heading',
];

/** Fixes that are a link ("See Pro"); applying one changes nothing. */
export const STUDIO_FIX_LINKS_V3: readonly string[] = ['see-pro'];

// ---------------------------------------------------------------------------------------------
// Slot widths (the style's layout, §9)

/**
 * Desktop (≥ 1024 px) widths per style, from the §9 layouts. `text`: text and quote; `media`:
 * photo and video; `list`: services, events and the supporter wall; `tile`: one gallery photo.
 * Where a layout leaves the spans to the builder, the widest a block can be is used, so the
 * photo check is never too lenient. Sprint's photos run full-bleed (`bleed`): a photo block and a
 * gallery photo are the screen's width at every size (§9.6).
 */
interface Desktop {
  text: number;
  media: number;
  list: number;
  tile: number;
  bleed?: true;
}

// Classic's widths follow the screen (classicSlot, below).
const DESKTOP: Record<Exclude<StudioStyleId, 'classic'>, Desktop> = {
  // Content 920, a 2-column grid with a 40 px gap; photos 3-up squares in the 440 column, gap 8.
  clear: { text: 440, media: 440, list: 440, tile: 141 },
  // Content 1120: a 420 px column, gap 96, the rest (604); text maxes at 520; photos 3-up, gap 6.
  journal: { text: 520, media: 604, list: 604, tile: 197 },
  // Content 1200: a 400 px rail, gap 80, the main column (720); photos 3-up, gap 8.
  stage: { text: 720, media: 720, list: 720, tile: 235 },
  // Content 1120: 440 px (the first block), gap 80, the rest (600); photos 3-up, gap 8.
  signboard: { text: 600, media: 600, list: 600, tile: 195 },
  // After the split, photos run full-bleed; the other blocks sit in a grid of the rest of 1280
  // and 480, gap 120 (680 and 480). A video is not a photo: it takes the 680 cell.
  sprint: { text: 680, media: 680, list: 680, tile: 1440, bleed: true },
  // Content 1200: a 340 px rail, gap 72 (the canvas), a 4-column grid (788), gap 16: a tile is
  // 185. Photos, video, text and lists take the grid's whole width (builder's call on spans). A
  // gallery photo is a tile, but the last one closes its row: the last of 4n + 1 spans all 788.
  tiles: { text: 788, media: 788, list: 788, tile: 788 },
  // Content 1120: 600 px and the rest; photos 3fr/2fr, gap 8.
  linen: { text: 600, media: 600, list: 600, tile: 355 },
  // Content 1040: 440 px, gap 80, the right column (520), where every block sits (builder's
  // call); photos 3-up, gap 16.
  horizon: { text: 520, media: 520, list: 520, tile: 163 },
};

/**
 * Classic draws its blocks on today's page (§9.1, classic.css; apps/web test studio-classic holds
 * these numbers to the CSS). From 861 px two columns: the sheet min(1120, vw − 80), less the
 * 408 px tip rail, the clamp(32, 5vw, 72) gap and the 40 px inset the person's column has, so
 * 612 at 1200 (the widest), 600 at 1440, about 0.95·vw − 528 below 1200. Up to 860 px one
 * column: min(vw, 576) − 32. Every block fills the column; a gallery photo is 2-up, gap 8.
 */
const CLASSIC = {
  twoColumns: 861,
  sheet: 1120,
  sheetGutter: 80,
  rail: 408,
  gap: { min: 32, vw: 0.05, max: 72 },
  inset: 40,
  phoneMax: 576,
  phoneGutter: 16,
  tileGap: 8,
} as const;

function classicSlot(kind: StudioBlockKind, screen: number): number {
  const c = CLASSIC;
  const column =
    screen >= c.twoColumns
      ? Math.min(c.sheet, screen - c.sheetGutter) -
        c.rail -
        Math.min(Math.max(c.gap.min, c.gap.vw * screen), c.gap.max) -
        c.inset
      : Math.min(screen, c.phoneMax) - 2 * c.phoneGutter;
  return Math.round(kind === 'gallery' ? (column - c.tileGap) / 2 : column);
}

/** Clear's phone and tablet photo strip: 150×200 tiles (clear.css `.studio-strip li`). */
const CLEAR_STRIP_TILE = 150;
/** Stage's: 156×208 tiles (§9.4; stage.css `.studio-strip li`). */
const STAGE_STRIP_TILE = 156;
const PHONE_GUTTER = 20;
const TABLET_GUTTER = 24;
const TABLET_MAX = 720;

/**
 * The widest a block of this kind can be, in CSS px, in this style at this screen width. Below
 * 768 px the page is one column with 20 px gutters (Clear: 390 → 350); from 768 to 1023 one column
 * with 24 px gutters up to 720; from 1024 px the style's own layout. For a gallery it is one photo.
 * It depends only on style, kind and screen: no person chooses a column or a span.
 */
export function studioSlotWidth(
  style: StudioStyleId,
  kind: StudioBlockKind,
  viewport: number,
): number {
  const screen = Math.min(Math.max(viewport, 0), 1440);
  if (style === 'classic') return classicSlot(kind, screen);
  const d = DESKTOP[style];
  // Sprint's photos run edge to edge at every width (§9.6; a gallery's odd first photo, or a
  // desktop row's lone photo, takes the whole row).
  if (d.bleed && (kind === 'photo' || kind === 'gallery')) return screen;
  if (screen >= 1024) {
    const room = screen - 2 * TABLET_GUTTER;
    switch (kind) {
      case 'text':
      case 'quote':
        return Math.min(d.text, room);
      case 'photo':
      case 'video':
        return Math.min(d.media, room);
      case 'gallery':
        return Math.min(d.tile, room);
      default:
        return Math.min(d.list, room);
    }
  }
  const column =
    screen < 768
      ? screen - 2 * PHONE_GUTTER
      : Math.min(screen - 2 * TABLET_GUTTER, TABLET_MAX);
  if (kind !== 'gallery') return column;
  // One gallery photo on a phone or tablet: Clear's and Stage's strips of fixed tiles (§9.2,
  // §9.4), Journal 3-up (gap 6), Horizon and Signboard 3-up (gap 8), Tiles 2-up (gap 12, an odd
  // last photo spanning both: the column), Linen 3fr/2fr (gap 8, the larger).
  if (style === 'clear') return CLEAR_STRIP_TILE;
  if (style === 'stage') return STAGE_STRIP_TILE;
  if (style === 'journal') return Math.round((column - 12) / 3);
  if (style === 'horizon' || style === 'signboard')
    return Math.round((column - 16) / 3);
  if (style === 'tiles') return column;
  return Math.round(((column - 8) * 3) / 5);
}

// ---------------------------------------------------------------------------------------------
// Helpers

const fontById = (id: string): StudioFont =>
  STUDIO_FONTS.find((f) => f.id === id) ?? (STUDIO_FONTS[0] as StudioFont);
const INTER = (): StudioFont => fontById('inter');

/** Whether `text` has a required letter the font can't draw. */
const lacks = (font: StudioFont, text: string): boolean =>
  font.missing.length > 0 &&
  [...text].some((c) => font.missing.includes(c.codePointAt(0) ?? 0));

const snippet = (s: string) =>
  [...s].length > 24 ? `${[...s].slice(0, 24).join('')}…` : s;
const number = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Heading size at 320 px, per style (builder's call within §9; it only feeds the width check).
 * Kept in step with each style's CSS (apps/web/src/components/studio-styles/<style>.css; apps/web
 * test studio-style-page holds them): Clear's phone section title is 20/26 (§9.2), Journal's
 * 22/29 (§9.3), Stage's 22/28 (§9.4), Signboard's 15/22 caps (§9.5), Sprint's 20/26 (§9.6),
 * Tiles' 15/20 (its text tile title, §9.7), Linen's 24/30 (§9.8), Horizon's 18/24 (§9.9).
 */
export const STUDIO_HEADING_PX: Record<StudioStyleId, number> = {
  // classic.css .studio-title: 2rem at every width (apps/web test studio-classic holds it).
  classic: 32,
  clear: 20,
  journal: 22,
  stage: 22,
  signboard: 15,
  sprint: 20,
  tiles: 15,
  linen: 24,
  horizon: 18,
};

function copy(doc: StudioDocument): StudioDocument {
  return {
    ...doc,
    blocks: doc.blocks.map((b): StudioBlock => {
      if (b.kind === 'gallery')
        return { ...b, images: b.images.map((i) => ({ ...i })) };
      if (b.kind === 'services')
        return { ...b, items: b.items.map((i) => ({ ...i })) };
      if (b.kind === 'events')
        return { ...b, items: b.items.map((i) => ({ ...i })) };
      return { ...b };
    }),
  };
}

/** What a Pro plan unlocks that this document uses (§11). */
export function proItemsOf(doc: StudioDocument): {
  style: boolean;
  photoAccent: boolean;
  blockIds: string[];
} {
  return {
    style: STUDIO_STYLES[doc.style].plan === 'pro',
    photoAccent: doc.accent === 'photo',
    blockIds: doc.blocks
      .filter((b) => STUDIO_PRO_BLOCKS.includes(b.kind))
      .map((b) => b.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Photos and page weight

const MAX_RENDITION = RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1] as number;
const DPR = STUDIO_WEIGHT.dpr;
/** The widest screen the model sizes for: photos are judged at their spot here. */
const WIDEST = 1440;

/** Pixels a stored photo can fill, after the crop (a wide crop for a block, a square for a tile). */
function usable(
  ctx: StudioCheckContext,
  imageId: string,
  shape: 'wide' | 'square',
): number {
  const f = ctx.images[imageId];
  if (!f) return 0;
  return Math.floor(Math.min(f.width, f.height * STUDIO_IMAGE_ASPECT[shape]));
}

/** As in v1: a photo needs the width of its slot at the widest screen, at 1x. */
function neededWidth(style: StudioStyleId, kind: 'photo' | 'gallery'): number {
  return Math.round(studioSlotWidth(style, kind, WIDEST));
}

/** Bytes a photo costs at a slot: the stored file's, scaled to the rendition the slot loads. */
function photoBytes(
  ctx: StudioCheckContext,
  imageId: string,
  cssWidth: number,
): number {
  const need = cssWidth * DPR;
  const width = RENDITION_WIDTHS.find((w) => w >= need) ?? MAX_RENDITION;
  const f = ctx.images[imageId];
  if (!f) return Math.round(width * width * 0.75 * 0.08);
  const scale = Math.min(1, (width / Math.max(1, f.width)) ** 2);
  return Math.round(f.bytes * scale);
}

/** Height of a block at its slot width `w` (a gallery's is one tile's width). */
function blockHeight(b: StudioBlock, w: number): number {
  const lines = (text: string, perChar: number) =>
    Math.max(1, Math.ceil(([...text].length * perChar) / w));
  switch (b.kind) {
    case 'text':
      return b.variant === 'heading'
        ? lines(b.text, 13) * 32 + 8
        : lines(b.text, 8.5) * 26 + (b.text.split('\n\n').length - 1) * 16 + 8;
    case 'quote':
      return lines(b.text, 10.6) * 30 + 32;
    case 'services':
      return 112 * b.items.length + 8;
    case 'events':
      return 120 * b.items.length + 8;
    case 'video':
      return (w * 9) / 16 + (b.caption ? 24 : 0);
    case 'photo':
      return w / STUDIO_IMAGE_ASPECT.wide + (b.caption ? 24 : 0);
    case 'gallery': {
      // `w` is one tile's width here.
      return Math.ceil(b.images.length / 2) * (w + 8);
    }
    case 'supporters':
      return 80;
  }
}

/** Estimated first load on a 390 px phone, and the block holding the heaviest photo in it. */
function weightOf(
  doc: StudioDocument,
  ctx: StudioCheckContext,
): { bytes: number; heaviest: string } {
  const display = STUDIO_STYLES[doc.style].displayFont;
  const fileBytes = (f: StudioFont) =>
    f.files.reduce((s, file) => s + file.bytes, 0);
  let bytes = STUDIO_WEIGHT.base + fileBytes(INTER());
  if (display && display !== 'inter') bytes += fileBytes(fontById(display));
  const fold =
    STUDIO_WEIGHT.screen * STUDIO_WEIGHT.screens - STUDIO_WEIGHT.aboveStudio;
  let y = 0;
  let heaviest = { bytes: 0, block: '' };
  const count = (add: number, block: string) => {
    bytes += add;
    if (add > heaviest.bytes) heaviest = { bytes: add, block };
  };
  for (const b of doc.blocks) {
    if (y >= fold) break;
    const w = studioSlotWidth(doc.style, b.kind, STUDIO_WEIGHT.phone);
    if (b.kind === 'photo') count(photoBytes(ctx, b.imageId, w), b.id);
    if (b.kind === 'gallery') {
      const tile = w + 8;
      b.images.forEach((image, i) => {
        if (y + Math.floor(i / 2) * tile < fold)
          count(photoBytes(ctx, image.imageId, w), b.id);
      });
    }
    y += blockHeight(b, w) + 16;
  }
  return { bytes, heaviest: heaviest.block };
}

// ---------------------------------------------------------------------------------------------
// The rules

const KIND_WORDS: Record<StudioBlockKind, string> = {
  text: 'Text',
  photo: 'A photo',
  gallery: 'A gallery',
  video: 'A video',
  services: 'Services',
  events: 'Events',
  quote: 'A quote',
  supporters: 'The supporter wall',
};
const BLOCK_NAMES: Record<StudioBlockKind, string> = {
  text: 'text',
  photo: 'photo',
  gallery: 'gallery',
  video: 'video',
  services: 'services',
  events: 'events',
  quote: 'quote',
  supporters: 'supporter wall',
};

interface Raw {
  rule: StudioRuleId;
  at: StudioIssue['at'];
  message: string;
  detail?: string;
  fixes: FixId[];
}

/** Rules about the whole page: two issues of one of these are the same issue wherever they point. */
const PAGE_RULES: readonly StudioRuleId[] = ['page-weight'];

function sameIssue(
  a: Pick<StudioIssue, 'rule' | 'at'>,
  b: Pick<StudioIssue, 'rule' | 'at'>,
): boolean {
  if (a.rule !== b.rule) return false;
  if (PAGE_RULES.includes(a.rule)) return true;
  return a.at.row === b.at.row && a.at.block === b.at.block;
}

function isEmpty(b: StudioBlock): boolean {
  switch (b.kind) {
    case 'gallery':
      return b.images.length === 0;
    case 'services':
    case 'events':
      return b.items.length === 0;
    case 'text':
    case 'quote':
      return b.text.length === 0;
    default:
      return false;
  }
}

/** Sprint's display face (Anton) sets the name only; its section titles are Inter (§9.6). */
const NAME_ONLY_FACE: readonly StudioStyleId[] = ['sprint'];
/**
 * Signboard's section titles are capitals with +0.03 em tracking (§9.5), so a heading word is
 * measured at the face's widest letter plus the tracking, not its mean advance.
 */
const CAPS_TITLES: Partial<Record<StudioStyleId, number>> = { signboard: 0.03 };

/** The face a heading is set in, and its size at 320 px; null for anything but a heading block. */
function headingFace(
  doc: StudioDocument,
  b: StudioBlock,
): { font: StudioFont; px: number; text: string } | null {
  const display = NAME_ONLY_FACE.includes(doc.style)
    ? null
    : STUDIO_STYLES[doc.style].displayFont;
  const face = (text: string) => {
    const font = display ? fontById(display) : INTER();
    return lacks(font, text) ? INTER() : font;
  };
  if (b.kind === 'text' && b.variant === 'heading')
    return {
      font: face(b.text),
      px: STUDIO_HEADING_PX[doc.style],
      text: b.text,
    };
  return null;
}

function rawIssues(doc: StudioDocument, ctx: StudioCheckContext): Raw[] {
  const out: Raw[] = [];
  const style = STUDIO_STYLES[doc.style];

  // pro-only (§11): a Free page can't publish a Pro style, the photo accent or a Pro block.
  if (ctx.plan !== 'pro') {
    const pro = proItemsOf(doc);
    if (pro.style)
      out.push({
        rule: 'pro-only',
        at: { row: 'style' },
        message: `${style.name} is a Pro style`,
        detail: 'Choose a free style, or see Pro.',
        fixes: ['choose-free-style', 'see-pro'],
      });
    if (pro.photoAccent)
      out.push({
        rule: 'pro-only',
        at: { row: 'accent' },
        message: '“From your photo” is a Pro colour',
        detail: 'Use the style’s own colour, or see Pro.',
        fixes: ['use-default-accent', 'see-pro'],
      });
    for (const b of doc.blocks)
      if (pro.blockIds.includes(b.id))
        out.push({
          rule: 'pro-only',
          at: { row: '', block: b.id },
          message: `The ${BLOCK_NAMES[b.kind]} block needs Pro`,
          detail: 'Remove it, or see Pro.',
          fixes: ['remove-block', 'see-pro'],
        });
  }

  // photo-resolution: a source smaller than its biggest spot in this style.
  for (const b of doc.blocks) {
    const spots =
      b.kind === 'photo'
        ? [
            {
              imageId: b.imageId,
              shape: 'wide' as const,
              need: neededWidth(doc.style, 'photo'),
              n: 0,
            },
          ]
        : b.kind === 'gallery'
          ? b.images.map((image, i) => ({
              imageId: image.imageId,
              shape: 'square' as const,
              need: neededWidth(doc.style, 'gallery'),
              n: i,
            }))
          : [];
    const blurry = spots.find((s) => usable(ctx, s.imageId, s.shape) < s.need);
    if (!blurry) continue;
    out.push({
      rule: 'photo-resolution',
      at: { row: '', block: b.id },
      message: 'A photo will look blurry',
      detail: `${b.kind === 'gallery' ? `Gallery photo ${blurry.n + 1}: ` : ''}${number(usable(ctx, blurry.imageId, blurry.shape))} pixels wide, shown at up to ${number(blurry.need)}.`,
      fixes: ['replace-photo'],
    });
  }

  // photo-alt: every photo is described or marked decorative.
  for (const b of doc.blocks) {
    const missing =
      b.kind === 'photo'
        ? !b.decorative && b.alt === ''
        : b.kind === 'gallery' &&
          b.images.some((i) => !i.decorative && i.alt === '');
    if (missing)
      out.push({
        rule: 'photo-alt',
        at: { row: '', block: b.id },
        message: 'A photo has no description',
        detail:
          'Describe it for people who can’t see it, or mark it as decorative.',
        fixes: ['mark-decorative', 'add-description'],
      });
  }

  // empty-block
  for (const b of doc.blocks)
    if (isEmpty(b))
      out.push({
        rule: 'empty-block',
        at: { row: '', block: b.id },
        message: `${KIND_WORDS[b.kind]} is empty`,
        detail: 'It would show nothing. Fill it in or remove it.',
        fixes: ['remove-block'],
      });

  // broken-video
  const SITE = { tiktok: 'TikTok', audiomack: 'Audiomack' } as const;
  for (const b of doc.blocks) {
    if (b.kind !== 'video' || ctx.videos[b.url] !== 'gone') continue;
    let host = '';
    try {
      host = new URL(b.url).hostname;
    } catch {
      // A link the schema refuses; the generic site name below is enough.
    }
    const site = host.includes('tiktok')
      ? SITE.tiktok
      : host.includes('audiomack')
        ? SITE.audiomack
        : 'YouTube';
    out.push({
      rule: 'broken-video',
      at: { row: '', block: b.id },
      message: 'A video link doesn’t work',
      detail: `${site} says this video is private or removed.`,
      fixes: ['remove-video', 'change-link'],
    });
  }

  // page-weight: first load on a phone within budget.
  const weight = weightOf(doc, ctx);
  if (weight.bytes > STUDIO_WEIGHT.budget)
    out.push({
      rule: 'page-weight',
      at: { row: '', ...(weight.heaviest ? { block: weight.heaviest } : {}) },
      message: 'Your page is too heavy for phones',
      detail: `First load on a phone: ${number(weight.bytes / 1000)} KB of 1.5 MB.`,
      fixes: ['move-lower'],
    });

  // long-word: a heading word, in the style's display face at 320 px, wider than the column.
  const column = studioSlotWidth(doc.style, 'text', 320);
  for (const b of doc.blocks) {
    const t = headingFace(doc, b);
    if (!t || !t.text) continue;
    const m = t.font.metrics;
    const caps = CAPS_TITLES[doc.style];
    const perEm =
      caps === undefined
        ? (m.avgAdvance + m.maxWordAdvance) / 2 / m.unitsPerEm
        : m.maxWordAdvance / m.unitsPerEm + caps;
    const longest = t.text
      .split(/\s+/)
      .reduce((a, w) => ([...w].length > [...a].length ? w : a), '');
    if ([...longest].length * perEm * t.px <= column) continue;
    out.push({
      rule: 'long-word',
      at: { row: '', block: b.id },
      message: 'A long word won’t fit',
      detail: `“${snippet(longest)}” would break in the middle on a 320 px screen.`,
      fixes: ['shorter-heading'],
    });
  }

  // Listed in the spec's order.
  return STUDIO_ERROR_RULES_V3.flatMap((rule) =>
    out.filter((i) => i.rule === rule),
  );
}

// ---------------------------------------------------------------------------------------------
// Notices

function notices(doc: StudioDocument, ctx: StudioCheckContext): StudioNotice[] {
  const out: StudioNotice[] = [];
  const style = STUDIO_STYLES[doc.style];

  if (style.needsPhoto && doc.cover === 'yours' && ctx.coverKind !== 'photo')
    out.push({
      rule: 'cover-photo',
      message: `${style.name} looks best with a cover photo. Add one in Settings.`,
    });

  if (style.displayFont) {
    const face = fontById(style.displayFont);
    if (lacks(face, ctx.profile.name))
      out.push({
        rule: 'name-fallback',
        message: `Your name has a letter ${face.name} can't draw, so it's set in Inter.`,
      });
  }

  if (ctx.profile.links === 0)
    out.push({
      rule: 'missing-links',
      message: 'Add links in Settings to show them on your page.',
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
  if (!next) return false;
  const after = rawIssues(next, ctx);
  return (
    !after.some((a) => sameIssue(a, issue)) &&
    after.every((a) => before.some((b) => sameIssue(a, b)))
  );
}

function fixLabel(doc: StudioDocument, issue: Raw, fix: FixId): string {
  if (fix === 'use-default-accent') {
    const own = STUDIO_STYLES[doc.style].defaultAccent;
    return `Use ${own ? STUDIO_ACCENTS[own].name : CLASSIC_PURPLE.name}`;
  }
  if (fix === 'move-lower') {
    const block = doc.blocks.find((b) => b.id === issue.at.block);
    return block?.kind === 'gallery'
      ? STUDIO_FIX_LABELS['move-lower']
      : 'Move the photo lower';
  }
  return STUDIO_FIX_LABELS_V3[fix];
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
  const issues: StudioIssue[] = raw.map((issue) => {
    const fixes: StudioFix[] = issue.fixes
      .filter(
        (f) =>
          STUDIO_FIX_NEEDS_INPUT_V3.includes(f) ||
          STUDIO_FIX_LINKS_V3.includes(f) ||
          works(doc, ctx, issue, f, raw),
      )
      .map((f) => ({ id: f, label: fixLabel(doc, issue, f) }));
    return {
      rule: issue.rule,
      severity: 'error',
      at: issue.at,
      message: issue.message,
      ...(issue.detail ? { detail: issue.detail } : {}),
      fixes,
    };
  });
  return {
    version: DESIGN_CHECK_VERSION,
    issues,
    notices: notices(doc, ctx),
    passing: STUDIO_ERROR_RULES_V3.filter(
      (rule) => !issues.some((i) => i.rule === rule),
    ),
    weightBytes: weightOf(doc, ctx).bytes,
  };
}

/**
 * Applies one fix to a copy of the document. Pure. A fix that needs the person's input, a link,
 * or a fix that no longer applies returns an unchanged copy.
 */
export function applyStudioFix(
  doc: StudioDocument,
  issue: Pick<StudioIssue, 'rule' | 'at'>,
  fixId: string,
): StudioDocument {
  return applyFix(doc, issue, fixId) ?? copy(doc);
}

/** The fixed copy, or null when the fix needs input, is a link, or no longer applies. */
function applyFix(
  doc: StudioDocument,
  issue: Pick<StudioIssue, 'rule' | 'at'>,
  fixId: string,
): StudioDocument | null {
  const d = copy(doc);
  const at = issue.at.block
    ? d.blocks.findIndex((b) => b.id === issue.at.block)
    : -1;
  const block = at >= 0 ? d.blocks[at] : undefined;
  switch (fixId as FixId) {
    case 'use-default-accent':
      if (d.accent === null) return null;
      d.accent = null;
      return d;
    case 'remove-block':
    case 'remove-video':
      if (!block) return null;
      d.blocks.splice(at, 1);
      return d;
    case 'mark-decorative': {
      let changed = false;
      if (block?.kind === 'photo' && block.alt === '' && !block.decorative) {
        block.decorative = true;
        changed = true;
      }
      if (block?.kind === 'gallery')
        for (const image of block.images)
          if (image.alt === '' && !image.decorative) {
            image.decorative = true;
            changed = true;
          }
      return changed ? d : null;
    }
    case 'move-lower':
      if (!block || at >= d.blocks.length - 1) return null;
      d.blocks.splice(at, 2, d.blocks[at + 1] as StudioBlock, block);
      return d;
    default:
      // choose-free-style, see-pro, replace-photo, add-description, change-link, shorter-heading
      return null;
  }
}
