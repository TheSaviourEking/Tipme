/**
 * The Page Studio document, version 2 (styles spec §5.2). It stores a style id, an accent id (or
 * null for the style's own), a mode, a cover type and an ordered list of blocks, and nothing else:
 * no colour, font, size, radius, spacing, column split or CSS. The style decides how every block
 * looks. The legacy document (rows, brand colours, fonts) lives in studio-document-v1.ts.
 *
 * `studioDocumentSchema` is strict and is used for writes. `resolveStudio` is for reads: it takes a
 * v1 or v2 document (or anything else), never throws, and returns a document the schema accepts.
 * `migrateStudioV1` is the §7.1 table.
 */
import { z } from 'zod';
import { hexToOklch, type Hex, type StudioMode } from './studio-colour.js';
import {
  cleanStudioParagraph,
  parseVideoLink,
  resolveStudioV1,
  STUDIO_MODES,
  studioDocumentShared as shared,
  type StudioBlockV1,
  type StudioDocumentV1,
  type StudioImageRef,
} from './studio-document-v1.js';
import { STUDIO_LIMITS as L, STUDIO_SUPPORTER_WALL } from './studio-limits.js';
import {
  STUDIO_ACCENT_IDS,
  STUDIO_ACCENTS,
  STUDIO_STYLE_IDS,
  STUDIO_STYLES,
  type StudioAccentId,
  type StudioCoverType,
  type StudioCuratedAccentId,
  type StudioStyleId,
} from './studio-styles.js';

const { ID, UUID, TIME, fit, isLine, isParagraph, isDate, isKobo } = shared;
const { isObj, optional, without } = shared;

// ---------------------------------------------------------------------------------------------
// Types

export type StudioBlockKind =
  | 'text'
  | 'photo'
  | 'gallery'
  | 'video'
  | 'services'
  | 'events'
  | 'quote'
  | 'supporters';

/** The block kinds that need Pro (§11). */
export const STUDIO_PRO_BLOCKS: readonly StudioBlockKind[] = [
  'photo',
  'gallery',
  'video',
  'services',
  'events',
];

export const STUDIO_COVER_TYPES = [
  'yours',
  'gradient',
  'plain',
] as const satisfies readonly StudioCoverType[];

export type StudioBlock =
  | { id: string; kind: 'text'; variant: 'heading' | 'paragraph'; text: string }
  | {
      id: string;
      kind: 'photo';
      imageId: string;
      alt: string;
      decorative?: true;
      caption?: string;
    }
  | { id: string; kind: 'gallery'; images: StudioImageRef[] }
  | { id: string; kind: 'video'; url: string; caption?: string }
  | {
      id: string;
      kind: 'services';
      items: {
        name: string;
        detail?: string;
        priceMinor: string;
        from?: true;
      }[];
    }
  | {
      id: string;
      kind: 'events';
      items: {
        date: string;
        time?: string;
        title: string;
        place?: string;
        note?: string;
      }[];
    }
  | { id: string; kind: 'quote'; text: string }
  /** Refused until the supporter wall ships (STUDIO_SUPPORTER_WALL). */
  | { id: string; kind: 'supporters' };

export interface StudioDocument {
  v: 2;
  style: StudioStyleId;
  /** null = this style's own default accent (TipMe purple on Classic). */
  accent: StudioAccentId | null;
  mode: StudioMode;
  cover: StudioCoverType;
  /** The order is the page order. */
  blocks: StudioBlock[];
}

// ---------------------------------------------------------------------------------------------
// Schema (writes)

const id = z.string().regex(ID);
const uuid = z.string().regex(UUID);
const line = (max: number) =>
  z
    .string()
    .refine(
      (s) => isLine(s, max),
      `one clean line of at most ${max} characters`,
    );
const filled = (max: number) =>
  line(max).refine((s) => s.length > 0, 'required');
const yes = z.literal(true).optional();
const imageRef = z.strictObject({
  imageId: uuid,
  alt: line(L.alt),
  decorative: yes,
});

const blockSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      id,
      kind: z.literal('text'),
      variant: z.enum(['heading', 'paragraph']),
      text: z.string(),
    })
    .superRefine((b, ctx) => {
      const fits =
        b.variant === 'paragraph'
          ? isParagraph(b.text)
          : isLine(b.text, L.headingText);
      if (!fits)
        ctx.addIssue({
          code: 'custom',
          path: ['text'],
          message: 'text too long or not clean',
        });
    }),
  z.strictObject({
    id,
    kind: z.literal('photo'),
    imageId: uuid,
    alt: line(L.alt),
    decorative: yes,
    caption: filled(L.caption).optional(),
  }),
  z.strictObject({
    id,
    kind: z.literal('gallery'),
    images: z.array(imageRef).max(L.galleryImages),
  }),
  z.strictObject({
    id,
    kind: z.literal('video'),
    url: z
      .string()
      .max(L.videoUrl)
      .refine(
        (u) => parseVideoLink(u) !== null,
        'a link from YouTube, TikTok or Audiomack',
      ),
    caption: filled(L.caption).optional(),
  }),
  z.strictObject({
    id,
    kind: z.literal('services'),
    items: z
      .array(
        z.strictObject({
          name: filled(L.serviceName),
          detail: filled(L.serviceDetail).optional(),
          priceMinor: z
            .string()
            .refine(isKobo, 'whole naira, in kobo, ₦1 to ₦10,000,000'),
          from: yes,
        }),
      )
      .max(L.services),
  }),
  z.strictObject({
    id,
    kind: z.literal('events'),
    items: z
      .array(
        z.strictObject({
          date: z.string().refine(isDate, 'a real date, YYYY-MM-DD'),
          time: z.string().regex(TIME).optional(),
          title: filled(L.eventTitle),
          place: filled(L.eventPlace).optional(),
          note: filled(L.eventNote).optional(),
        }),
      )
      .max(L.events),
  }),
  z.strictObject({ id, kind: z.literal('quote'), text: line(L.quoteText) }),
  z
    .strictObject({ id, kind: z.literal('supporters') })
    .refine(
      () => STUDIO_SUPPORTER_WALL,
      'the supporter wall is not available yet',
    ),
]);

interface Counts {
  blocks: number;
  images: number;
  videos: number;
  events: number;
  services: number;
}

/** Page-wide totals over a block list. Shared by the schema and the resolver's trimming. */
function countsOf(blocks: readonly StudioBlock[]): Counts {
  const c: Counts = {
    blocks: blocks.length,
    images: 0,
    videos: 0,
    events: 0,
    services: 0,
  };
  for (const b of blocks) {
    if (b.kind === 'photo') c.images += 1;
    if (b.kind === 'gallery') c.images += b.images.length;
    if (b.kind === 'video') c.videos += 1;
    if (b.kind === 'events') c.events += b.items.length;
    if (b.kind === 'services') c.services += b.items.length;
  }
  return c;
}

const oneOf = <T extends string>(list: readonly T[]) =>
  z.enum(list as unknown as [T, ...T[]]);

const documentSchema = z
  .strictObject({
    v: z.literal(2),
    style: oneOf(STUDIO_STYLE_IDS),
    accent: oneOf(STUDIO_ACCENT_IDS).nullable(),
    mode: oneOf(STUDIO_MODES),
    cover: oneOf(STUDIO_COVER_TYPES),
    blocks: z.array(blockSchema).max(L.blocks),
  })
  .superRefine((doc, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (!STUDIO_STYLES[doc.style].covers.includes(doc.cover))
      fail(['cover'], 'a cover type this style offers');
    const ids = new Set<string>();
    doc.blocks.forEach((b, i) => {
      if (ids.has(b.id)) fail(['blocks', i], `id ${b.id} is used twice`);
      ids.add(b.id);
    });
    const c = countsOf(doc.blocks as unknown as StudioBlock[]);
    if (c.images > L.pageImages)
      fail(['blocks'], `at most ${L.pageImages} photos`);
    if (c.videos > L.videos) fail(['blocks'], `at most ${L.videos} videos`);
    if (c.events > L.events) fail(['blocks'], `at most ${L.events} events`);
    if (c.services > L.services)
      fail(['blocks'], `at most ${L.services} services`);
  });

/** Strict: refuses unknown keys, kinds, variants and anything past a limit. For writes. */
export const studioDocumentSchema =
  documentSchema as unknown as z.ZodType<StudioDocument>;

// ---------------------------------------------------------------------------------------------
// Defaults

/** A new page: Classic with nothing chosen. */
export function defaultStudioDocument(): StudioDocument {
  return {
    v: 2,
    style: 'classic',
    accent: null,
    mode: 'light',
    cover: 'yours',
    blocks: [],
  };
}

/** Whether this document is exactly what a page that never opened the Studio has (§9.1). */
export function isClassicDefault(doc: StudioDocument): boolean {
  return (
    doc.style === 'classic' &&
    doc.accent === null &&
    doc.mode === 'light' &&
    doc.cover === 'yours' &&
    doc.blocks.length === 0
  );
}

/** Every Studio photo the document uses: photo blocks and gallery photos. */
export function studioImageIdsOf(doc: StudioDocument): Set<string> {
  const out = new Set<string>();
  for (const b of doc.blocks) {
    if (b.kind === 'photo') out.add(b.imageId);
    if (b.kind === 'gallery') for (const i of b.images) out.add(i.imageId);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Migration (v1 → v2, §7.1)

type Lab = { l: number; a: number; b: number };
const lab = (hex: Hex): Lab => {
  const { l, c, h } = hexToOklch(hex);
  const rad = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
};
const distance = (x: Lab, y: Lab) =>
  Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);

/** The old default brand colour: no accent chosen. */
const OLD_DEFAULT_BRAND = '#7a32f9';

/** `brand[0]` as an accent (§7.1): the old purple is null, greys are Ink, else the nearest of 8. */
function accentFromBrand(brand: Hex): StudioAccentId | null {
  if (brand.toLowerCase() === OLD_DEFAULT_BRAND) return null;
  const own = lab(brand);
  if (hexToOklch(brand).c < 0.04) return 'ink';
  let best: StudioCuratedAccentId = 'ink';
  let bestDistance = Infinity;
  for (const key of Object.keys(STUDIO_ACCENTS) as StudioCuratedAccentId[]) {
    const d = distance(own, lab(STUDIO_ACCENTS[key].light.fill));
    if (d < bestDistance) {
      best = key;
      bestDistance = d;
    }
  }
  return best;
}

function styleFromV1(doc: StudioDocumentV1): StudioStyleId {
  const { heading, body } = doc.fonts;
  if (heading === 'source-serif-4' || heading === 'fraunces') return 'journal';
  if (doc.mode === 'dark') return 'stage';
  if (heading === 'dm-serif-display' && body === 'manrope') return 'classic';
  return 'clear';
}

/** One v1 block as a v2 block, or null when v2 has no such block (About, Links, supporters). */
function blockFromV1(b: StudioBlockV1): StudioBlock | null {
  switch (b.kind) {
    case 'text':
      return {
        id: b.id,
        kind: 'text',
        variant: b.variant === 'heading' ? 'heading' : 'paragraph',
        text: b.text,
      };
    case 'photo':
      return without({
        id: b.id,
        kind: 'photo' as const,
        imageId: b.imageId,
        alt: b.alt,
        decorative: b.decorative,
        caption: b.caption,
      });
    case 'gallery':
      return { id: b.id, kind: 'gallery', images: b.images };
    case 'video':
      return without({
        id: b.id,
        kind: 'video' as const,
        url: b.url,
        caption: b.caption,
      });
    case 'services':
      return { id: b.id, kind: 'services', items: b.items };
    case 'events':
      return { id: b.id, kind: 'events', items: b.items };
    case 'quote':
      return { id: b.id, kind: 'quote', text: b.text };
    case 'about':
    case 'links':
    case 'supporters':
      return null;
  }
}

/**
 * A valid v1 document as v2 (§7.1). The style comes from the fonts and mode, the accent from the
 * first brand colour, the mode is kept, the cover is "Your cover", and the rows flatten to blocks
 * in reading order: row by row, the left column first, each top to bottom. About, Links, supporter
 * blocks and photo row backgrounds are dropped, and variants and levels go. `lead` is a paragraph.
 */
export function migrateStudioV1(doc: StudioDocumentV1): StudioDocument {
  const blocks = doc.rows
    .flatMap((row) => row.cells.flat())
    .map(blockFromV1)
    .filter((b): b is StudioBlock => b !== null);
  return {
    v: 2,
    style: styleFromV1(doc),
    accent: accentFromBrand(doc.brand[0]),
    mode: doc.mode,
    cover: 'yours',
    blocks,
  };
}

// ---------------------------------------------------------------------------------------------
// Resolver (reads)

const pick = <T extends string>(v: unknown, from: readonly T[], or: T): T =>
  from.includes(v as T) ? (v as T) : or;

function imageRefOf(v: unknown): StudioImageRef | null {
  if (!isObj(v) || typeof v['imageId'] !== 'string' || !UUID.test(v['imageId']))
    return null;
  return without({
    imageId: v['imageId'],
    alt: fit(v['alt'], L.alt),
    decorative: v['decorative'] === true ? (true as const) : undefined,
  });
}

/** One block as stored, or null when it can't be shown (unknown kind, no image, bad link). */
function blockOf(v: unknown, today: string): StudioBlock | null {
  if (!isObj(v) || typeof v['kind'] !== 'string') return null;
  const kind = v['kind'];
  const blockId = typeof v['id'] === 'string' ? v['id'] : '';
  const caption = () => optional(fit(v['caption'], L.caption));
  switch (kind) {
    case 'text': {
      // A heading stays a heading; `lead`, `paragraph` and anything else is a paragraph.
      if (v['variant'] === 'heading')
        return {
          id: blockId,
          kind,
          variant: 'heading',
          text: fit(v['text'], L.headingText),
        };
      return {
        id: blockId,
        kind,
        variant: 'paragraph',
        text: fit(v['text'], L.paragraphText, cleanStudioParagraph),
      };
    }
    case 'photo': {
      const image = imageRefOf(v);
      if (!image) return null;
      return without({ id: blockId, kind, ...image, caption: caption() });
    }
    case 'gallery': {
      const images = (Array.isArray(v['images']) ? v['images'] : [])
        .map(imageRefOf)
        .filter((i): i is StudioImageRef => i !== null)
        .slice(0, L.galleryImages);
      return { id: blockId, kind, images };
    }
    case 'video': {
      const url = typeof v['url'] === 'string' ? v['url'].trim() : '';
      if (url.length > L.videoUrl || !parseVideoLink(url)) return null;
      return without({ id: blockId, kind, url, caption: caption() });
    }
    case 'services': {
      const items = (Array.isArray(v['items']) ? v['items'] : [])
        .filter(isObj)
        .map((i) =>
          without({
            name: fit(i['name'], L.serviceName),
            detail: optional(fit(i['detail'], L.serviceDetail)),
            priceMinor:
              typeof i['priceMinor'] === 'string' ? i['priceMinor'] : '',
            from: i['from'] === true ? (true as const) : undefined,
          }),
        )
        .filter((i) => i.name.length > 0 && isKobo(i.priceMinor))
        .slice(0, L.services);
      return { id: blockId, kind, items };
    }
    case 'events': {
      const items = (Array.isArray(v['items']) ? v['items'] : [])
        .filter(isObj)
        .map((i) =>
          without({
            date: typeof i['date'] === 'string' ? i['date'] : '',
            time:
              typeof i['time'] === 'string' && TIME.test(i['time'])
                ? i['time']
                : undefined,
            title: fit(i['title'], L.eventTitle),
            place: optional(fit(i['place'], L.eventPlace)),
            note: optional(fit(i['note'], L.eventNote)),
          }),
        )
        // Past events hide by themselves (Lagos date, passed in by the caller).
        .filter((i) => isDate(i.date) && i.date >= today && i.title.length > 0)
        .slice(0, L.events);
      return { id: blockId, kind, items };
    }
    case 'quote':
      return { id: blockId, kind, text: fit(v['text'], L.quoteText) };
    case 'supporters':
      return STUDIO_SUPPORTER_WALL ? { id: blockId, kind } : null;
    default:
      // Unknown kinds, and `about` and `links`, which v2 does not have.
      return null;
  }
}

/** Page-wide limits, in reading order: whatever comes later is trimmed first. */
function withinLimits(blocks: StudioBlock[]): StudioBlock[] {
  const left = {
    blocks: L.blocks,
    images: L.pageImages,
    videos: L.videos,
    events: L.events,
    services: L.services,
  };
  return blocks.flatMap((b): StudioBlock[] => {
    if (left.blocks < 1) return [];
    let next: StudioBlock = b;
    if (b.kind === 'photo') {
      if (left.images < 1) return [];
      left.images -= 1;
    }
    if (b.kind === 'video') {
      if (left.videos < 1) return [];
      left.videos -= 1;
    }
    if (b.kind === 'gallery') {
      const n = Math.min(b.images.length, left.images);
      left.images -= n;
      next = { ...b, images: b.images.slice(0, n) };
    }
    if (b.kind === 'events' || b.kind === 'services') {
      const n = Math.min(b.items.length, left[b.kind]);
      if (b.kind === 'events') left.events -= n;
      else left.services -= n;
      next = { ...b, items: b.items.slice(0, n) } as StudioBlock;
    }
    left.blocks -= 1;
    return [next];
  });
}

/** Keeps each valid id the first time it appears; gives every other block a new one. */
function withIds(blocks: StudioBlock[]): StudioBlock[] {
  const seen = new Set<string>();
  const kept = blocks.map((b) => {
    if (!ID.test(b.id) || seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });
  let n = 0;
  const fresh = () => {
    let candidate: string;
    do candidate = `n${(n++).toString(36).padStart(7, '0')}`;
    while (seen.has(candidate));
    seen.add(candidate);
    return candidate;
  };
  return blocks.map((b, i) => (kept[i] ? b : { ...b, id: fresh() }));
}

function resolveV2(o: Record<string, unknown>, today: string): StudioDocument {
  const style = pick(o['style'], STUDIO_STYLE_IDS, 'classic');
  const accent = STUDIO_ACCENT_IDS.includes(o['accent'] as StudioAccentId)
    ? (o['accent'] as StudioAccentId)
    : null;
  const offered = STUDIO_STYLES[style].covers;
  const cover = pick(o['cover'], offered, 'yours');
  const blocks = (Array.isArray(o['blocks']) ? o['blocks'] : [])
    .map((b) => blockOf(b, today))
    .filter((b): b is StudioBlock => b !== null);
  return {
    v: 2,
    style,
    accent,
    mode: pick(o['mode'], STUDIO_MODES, 'light'),
    cover,
    blocks: withIds(withinLimits(blocks)),
  };
}

/**
 * A stored document as a page can show it: v2 in gives a clean v2, v1 in is migrated (§7.1), and
 * anything else is the default Classic document. Never throws. Unknown choices become the default
 * one, a cover the style does not offer becomes "Your cover", unknown blocks are dropped, lists
 * past a limit are trimmed from the end, and events before `today` (the Lagos date, YYYY-MM-DD)
 * are hidden. It is idempotent, and a valid v2 document comes back unchanged.
 */
export function resolveStudio(raw: unknown, today: string): StudioDocument {
  try {
    if (isObj(raw) && raw['v'] === 2) return resolveV2(raw, today);
    if (isObj(raw) && raw['v'] === 1) {
      const legacy = resolveStudioV1(raw, today);
      // DM Serif Display with Manrope is today's Classic pairing (§7.1), but v1's font roles do not
      // let Manrope be a body face, so resolveStudioV1 swaps it for Inter. Read the pair as stored.
      const stored = isObj(raw['fonts']) ? raw['fonts'] : {};
      if (
        stored['heading'] === 'dm-serif-display' &&
        stored['body'] === 'manrope'
      )
        legacy.fonts = {
          heading: 'dm-serif-display',
          body: 'manrope' as never,
        };
      return resolveV2(
        migrateStudioV1(legacy) as unknown as Record<string, unknown>,
        today,
      );
    }
  } catch {
    // Fall through to the default.
  }
  return defaultStudioDocument();
}
