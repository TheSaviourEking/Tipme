/**
 * The Page Studio document (plan 2026-11-12-page-studio, Task 3): rows on a 12-column grid,
 * columns, and blocks. Every stored field is a typed choice: brand hex colours (which never reach
 * CSS; see studio-colour.ts), registry ids, enum steps, user text, kobo strings, dates and TipMe
 * image ids. Nothing in it is a CSS length, position, size, font name, URL to an image, or style.
 *
 * `studioDocumentSchema` is strict and is used for writes. `resolveStudio` is for reads: it never
 * throws, and turns anything (an old document, a registry change, a hand-edited row) into a
 * document the schema accepts.
 */
import { z } from 'zod';
import {
  isHex,
  type Hex,
  type StudioMode,
  type StudioPalette,
} from './studio-colour.js';
import { STUDIO_LIMITS as L, STUDIO_SUPPORTER_WALL } from './studio-limits.js';
import {
  STUDIO_DEFAULT_FONTS,
  STUDIO_FONTS,
  fontsOk,
  type StudioFontId,
  type StudioScaleStep,
} from './studio-type.js';

// ---------------------------------------------------------------------------------------------
// Types

/** Each list starts with the value `resolveStudio` uses when a stored one is unknown. */
export const STUDIO_MODES = [
  'light',
  'dark',
  'auto',
] as const satisfies readonly StudioMode[];
export const STUDIO_SCALES = [
  'standard',
  'compact',
  'roomy',
] as const satisfies readonly StudioScaleStep[];
export const STUDIO_CORNERS = ['soft', 'square', 'round'] as const;
export const STUDIO_COLUMNS = ['1', '1-1', '2-1', '1-2', '1-1-1'] as const;
export const STUDIO_SPACINGS = ['m', 's', 'l'] as const;
export const STUDIO_BACKGROUNDS = ['page', 'card', 'colour', 'second'] as const;

export type StudioColumns = (typeof STUDIO_COLUMNS)[number];
export type StudioSpacing = (typeof STUDIO_SPACINGS)[number];
export type StudioRowBackground =
  (typeof STUDIO_BACKGROUNDS)[number] | { photo: string /* imageId */ };

export const STUDIO_BLOCK_VARIANTS = {
  text: ['paragraph', 'heading', 'lead'],
  photo: ['square', 'wide', 'tall', 'circle'],
  gallery: ['grid', 'strip', 'mosaic'],
  video: ['still'],
  services: ['list', 'cards'],
  events: ['list', 'cards'],
  links: ['buttons', 'icons'],
  quote: ['plain', 'band'],
  about: ['plain'],
  supporters: ['names'],
} as const;
export type StudioBlockKind = keyof typeof STUDIO_BLOCK_VARIANTS;

export interface StudioImageRef {
  imageId: string;
  alt: string;
  decorative?: true;
}

export type StudioBlock =
  | {
      id: string;
      kind: 'text';
      variant: 'heading' | 'paragraph' | 'lead';
      level?: 2 | 3;
      text: string;
    }
  | {
      id: string;
      kind: 'photo';
      variant: 'square' | 'wide' | 'tall' | 'circle';
      imageId: string;
      alt: string;
      decorative?: true;
      caption?: string;
    }
  | {
      id: string;
      kind: 'gallery';
      variant: 'grid' | 'strip' | 'mosaic';
      images: StudioImageRef[];
    }
  | {
      id: string;
      kind: 'video';
      variant: 'still';
      url: string;
      caption?: string;
    }
  | {
      id: string;
      kind: 'services';
      variant: 'list' | 'cards';
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
      variant: 'list' | 'cards';
      items: {
        date: string;
        time?: string;
        title: string;
        place?: string;
        note?: string;
      }[];
    }
  /** Shows the person's existing social links; no new URLs. */
  | { id: string; kind: 'links'; variant: 'buttons' | 'icons' }
  | { id: string; kind: 'quote'; variant: 'plain' | 'band'; text: string }
  /** The bio, as today. */
  | { id: string; kind: 'about'; variant: 'plain' }
  /** Refused until Task 13 (STUDIO_SUPPORTER_WALL). */
  | { id: string; kind: 'supporters'; variant: 'names' };

export interface StudioRow {
  id: string;
  columns: StudioColumns;
  spacing: StudioSpacing;
  background: StudioRowBackground;
  /** One list of blocks per column: `cells.length` is the column count. */
  cells: StudioBlock[][];
}

export interface StudioDocument {
  v: 1;
  brand: [Hex] | [Hex, Hex];
  mode: StudioMode;
  fonts: { heading: StudioFontId; body: StudioFontId };
  scale: StudioScaleStep;
  corners: (typeof STUDIO_CORNERS)[number];
  rows: StudioRow[];
}

/** What the public page receives (Task 7 adds it to PublicProfile behind PAGE_STUDIO_ENABLED). */
export interface PublicStudio {
  document: StudioDocument;
  palette: StudioPalette;
  images: Record<string, { path: string; width: number; height: number }>;
  checkVersion: number;
}

export const columnCount = (columns: StudioColumns): number =>
  columns.split('-').length;

// ---------------------------------------------------------------------------------------------
// Text

const codePoints = (s: string) => [...s].length;

/**
 * One line of user text as stored: tabs and line breaks become spaces; C0 and C1 controls and the
 * bidi overrides and isolates (U+202A–202E, U+2066–2069) are removed; NFC; trimmed.
 */
export function cleanStudioText(s: string): string {
  return s
    .replace(/[\t\n\r]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .normalize('NFC')
    .trim();
}

/** A paragraph block: up to 4 paragraphs separated by one blank line, each cleaned to one line. */
export function cleanStudioParagraph(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(cleanStudioText)
    .filter((part) => part.length > 0)
    .slice(0, L.paragraphBreaks + 1)
    .join('\n\n');
}

/** Cleaned and cut to `max` code points (cleaning again, since a cut can leave a space). */
function fit(
  s: unknown,
  max: number,
  clean: (s: string) => string = cleanStudioText,
): string {
  let out = clean(typeof s === 'string' ? s : '');
  for (let i = 0; i < 4 && codePoints(out) > max; i += 1)
    out = clean([...out].slice(0, max).join(''));
  return codePoints(out) > max ? [...out].slice(0, max).join('') : out;
}

const isLine = (s: string, max: number) =>
  cleanStudioText(s) === s && codePoints(s) <= max;
const isParagraph = (s: string) =>
  cleanStudioParagraph(s) === s && codePoints(s) <= L.paragraphText;

// ---------------------------------------------------------------------------------------------
// Videos

export const STUDIO_VIDEO_SITES = ['youtube', 'tiktok', 'audiomack'] as const;
export type StudioVideoSite = (typeof STUDIO_VIDEO_SITES)[number];

/** The only origins a Studio page frames, after a visitor taps play (Task 8 sets frame-src). */
export const STUDIO_EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://www.tiktok.com',
  'https://audiomack.com',
] as const;

const YOUTUBE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
];
const TIKTOK_HOSTS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'];
const AUDIOMACK_HOSTS = ['audiomack.com', 'www.audiomack.com'];
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * A video link from an allow-listed site, or null. Only https, the sites' own hosts (no look-alikes,
 * credentials or ports), and the page shapes each site uses for one video.
 */
export function parseVideoLink(
  url: string,
): { site: StudioVideoSite; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    const id = parts[0] ?? '';
    return parts.length === 1 && YOUTUBE_ID.test(id)
      ? { site: 'youtube', id }
      : null;
  }
  if (YOUTUBE_HOSTS.includes(host)) {
    let id = '';
    if (parts.length === 1 && parts[0] === 'watch')
      id = u.searchParams.get('v') ?? '';
    else if (
      parts.length === 2 &&
      ['shorts', 'embed', 'live'].includes(parts[0] ?? '')
    )
      id = parts[1] ?? '';
    return YOUTUBE_ID.test(id) ? { site: 'youtube', id } : null;
  }
  if (TIKTOK_HOSTS.includes(host)) {
    const [user = '', video, id = ''] = parts;
    return parts.length === 3 &&
      /^@[\w.-]{1,40}$/.test(user) &&
      video === 'video' &&
      /^\d{8,25}$/.test(id)
      ? { site: 'tiktok', id }
      : null;
  }
  if (AUDIOMACK_HOSTS.includes(host)) {
    const [artist = '', song, slug = ''] = parts;
    return parts.length === 3 &&
      song === 'song' &&
      SLUG.test(artist) &&
      SLUG.test(slug)
      ? { site: 'audiomack', id: `${artist}/song/${slug}` }
      : null;
  }
  return null;
}

export function embedUrl(v: { site: StudioVideoSite; id: string }): string {
  if (v.site === 'youtube')
    return `https://www.youtube-nocookie.com/embed/${v.id}`;
  if (v.site === 'tiktok') return `https://www.tiktok.com/embed/v2/${v.id}`;
  return `https://audiomack.com/embed/${v.id}`;
}

// ---------------------------------------------------------------------------------------------
// Schema (writes)

const ID = /^[a-z0-9]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

function isKobo(s: string): boolean {
  if (!/^[1-9]\d{0,12}$/.test(s)) return false;
  const v = BigInt(s);
  return v % 100n === 0n && v >= 100n && v <= L.priceMaxMinor;
}

const id = z.string().regex(ID);
const uuid = z.string().regex(UUID);
const hex = z.string().refine(isHex, 'a lower-case #rrggbb colour');
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
const fontId = z.enum(
  STUDIO_FONTS.map((f) => f.id) as [StudioFontId, ...StudioFontId[]],
);

const blockSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      id,
      kind: z.literal('text'),
      variant: z.enum(STUDIO_BLOCK_VARIANTS.text),
      level: z.union([z.literal(2), z.literal(3)]).optional(),
      text: z.string(),
    })
    .superRefine((b, ctx) => {
      if ((b.variant === 'heading') !== (b.level !== undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['level'],
          message: 'headings, and only headings, have a level',
        });
      const fits =
        b.variant === 'paragraph'
          ? isParagraph(b.text)
          : isLine(
              b.text,
              b.variant === 'heading' ? L.headingText : L.leadText,
            );
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
    variant: z.enum(STUDIO_BLOCK_VARIANTS.photo),
    imageId: uuid,
    alt: line(L.alt),
    decorative: yes,
    caption: filled(L.caption).optional(),
  }),
  z.strictObject({
    id,
    kind: z.literal('gallery'),
    variant: z.enum(STUDIO_BLOCK_VARIANTS.gallery),
    images: z.array(imageRef).max(L.galleryImages),
  }),
  z.strictObject({
    id,
    kind: z.literal('video'),
    variant: z.literal('still'),
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
    variant: z.enum(STUDIO_BLOCK_VARIANTS.services),
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
    variant: z.enum(STUDIO_BLOCK_VARIANTS.events),
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
  z.strictObject({
    id,
    kind: z.literal('links'),
    variant: z.enum(STUDIO_BLOCK_VARIANTS.links),
  }),
  z.strictObject({
    id,
    kind: z.literal('quote'),
    variant: z.enum(STUDIO_BLOCK_VARIANTS.quote),
    text: line(L.quoteText),
  }),
  z.strictObject({ id, kind: z.literal('about'), variant: z.literal('plain') }),
  z
    .strictObject({
      id,
      kind: z.literal('supporters'),
      variant: z.literal('names'),
    })
    .refine(
      () => STUDIO_SUPPORTER_WALL,
      'the supporter wall is not available yet',
    ),
]);

const rowSchema = z.strictObject({
  id,
  columns: z.enum(STUDIO_COLUMNS),
  spacing: z.enum(STUDIO_SPACINGS),
  background: z.union([
    z.enum(STUDIO_BACKGROUNDS),
    z.strictObject({ photo: uuid }),
  ]),
  cells: z.array(z.array(blockSchema).max(L.blocksPerCell)).min(1).max(3),
});

/** Page-wide totals, in reading order. Shared by the schema and the design check. */
export function studioCounts(doc: Pick<StudioDocument, 'rows'>) {
  const counts = {
    blocks: 0,
    images: 0,
    videos: 0,
    events: 0,
    services: 0,
    about: 0,
    links: 0,
  };
  for (const row of doc.rows) {
    if (typeof row.background === 'object') counts.images += 1;
    for (const cell of row.cells)
      for (const b of cell) {
        counts.blocks += 1;
        if (b.kind === 'photo') counts.images += 1;
        if (b.kind === 'gallery') counts.images += b.images.length;
        if (b.kind === 'video') counts.videos += 1;
        if (b.kind === 'events') counts.events += b.items.length;
        if (b.kind === 'services') counts.services += b.items.length;
        if (b.kind === 'about') counts.about += 1;
        if (b.kind === 'links') counts.links += 1;
      }
  }
  return counts;
}

const documentSchema = z
  .strictObject({
    v: z.literal(1),
    brand: z.union([z.tuple([hex]), z.tuple([hex, hex])]),
    mode: z.enum(STUDIO_MODES),
    fonts: z.strictObject({ heading: fontId, body: fontId }),
    scale: z.enum(STUDIO_SCALES),
    corners: z.enum(STUDIO_CORNERS),
    rows: z.array(rowSchema).max(L.rows),
  })
  .superRefine((doc, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (
      !fontsOk(
        doc.fonts.heading as StudioFontId,
        doc.fonts.body as StudioFontId,
      )
    )
      fail(['fonts'], 'at most 2 families, each in a role it allows');
    const ids = new Set<string>();
    doc.rows.forEach((row, r) => {
      if (row.cells.length !== columnCount(row.columns))
        fail(['rows', r, 'cells'], 'one cell per column');
      if (row.background === 'second' && doc.brand.length !== 2)
        fail(
          ['rows', r, 'background'],
          'a second-colour row needs a second colour',
        );
      for (const each of [row.id, ...row.cells.flat().map((b) => b.id)]) {
        if (ids.has(each)) fail(['rows', r], `id ${each} is used twice`);
        ids.add(each);
      }
    });
    const c = studioCounts(doc as unknown as StudioDocument);
    if (c.blocks > L.blocks) fail(['rows'], `at most ${L.blocks} blocks`);
    if (c.images > L.pageImages)
      fail(['rows'], `at most ${L.pageImages} photos`);
    if (c.videos > L.videos) fail(['rows'], `at most ${L.videos} videos`);
    if (c.events > L.events) fail(['rows'], `at most ${L.events} events`);
    if (c.services > L.services)
      fail(['rows'], `at most ${L.services} services`);
    if (c.about > 1) fail(['rows'], 'About appears once');
    if (c.links > 1) fail(['rows'], 'Links appear once');
  });

/** Strict: refuses unknown keys, sizes, positions and anything past a limit. For writes. */
export const studioDocumentSchema =
  documentSchema as unknown as z.ZodType<StudioDocument>;

// ---------------------------------------------------------------------------------------------
// Resolver (reads)

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = <T extends string>(v: unknown, from: readonly T[]): T =>
  from.includes(v as T) ? (v as T) : (from[0] as T);
const optional = <T>(v: T | '' | undefined): T | undefined =>
  v === '' ? undefined : v;
const without = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function brandOf(v: unknown): [Hex] | [Hex, Hex] {
  const list = Array.isArray(v) ? v : [];
  const colour = (c: unknown) =>
    typeof c === 'string' && isHex(c.toLowerCase())
      ? (c.toLowerCase() as Hex)
      : null;
  const first = colour(list[0]) ?? '#7a32f9';
  const second = colour(list[1]);
  return second ? [first, second] : [first];
}

function fontsOf(v: unknown): StudioDocument['fonts'] {
  const f = isObj(v) ? v : {};
  const can = (id: unknown, role: 'heading' | 'body') =>
    STUDIO_FONTS.find((font) => font.id === id && font.roles.includes(role))
      ?.id;
  return {
    heading: can(f['heading'], 'heading') ?? STUDIO_DEFAULT_FONTS.heading,
    body: can(f['body'], 'body') ?? STUDIO_DEFAULT_FONTS.body,
  };
}

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
  if (
    !isObj(v) ||
    typeof v['kind'] !== 'string' ||
    !(v['kind'] in STUDIO_BLOCK_VARIANTS)
  )
    return null;
  const kind = v['kind'] as StudioBlockKind;
  const blockId = typeof v['id'] === 'string' ? v['id'] : '';
  const variant = pick(
    v['variant'],
    STUDIO_BLOCK_VARIANTS[kind] as readonly string[],
  );
  const caption = () => optional(fit(v['caption'], L.caption));
  switch (kind) {
    case 'text': {
      const t = variant as 'heading' | 'paragraph' | 'lead';
      if (t === 'heading')
        return {
          id: blockId,
          kind,
          variant: t,
          level: v['level'] === 3 ? 3 : 2,
          text: fit(v['text'], L.headingText),
        };
      if (t === 'lead')
        return {
          id: blockId,
          kind,
          variant: t,
          text: fit(v['text'], L.leadText),
        };
      return {
        id: blockId,
        kind,
        variant: t,
        text: fit(v['text'], L.paragraphText, cleanStudioParagraph),
      };
    }
    case 'photo': {
      const image = imageRefOf(v);
      if (!image) return null;
      return without({
        id: blockId,
        kind,
        variant: variant as 'square',
        ...image,
        caption: caption(),
      });
    }
    case 'gallery': {
      const images = (Array.isArray(v['images']) ? v['images'] : [])
        .map(imageRefOf)
        .filter((i): i is StudioImageRef => i !== null)
        .slice(0, L.galleryImages);
      return { id: blockId, kind, variant: variant as 'grid', images };
    }
    case 'video': {
      const url = typeof v['url'] === 'string' ? v['url'].trim() : '';
      if (url.length > L.videoUrl || !parseVideoLink(url)) return null;
      return without({
        id: blockId,
        kind,
        variant: 'still' as const,
        url,
        caption: caption(),
      });
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
      return { id: blockId, kind, variant: variant as 'list', items };
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
      return { id: blockId, kind, variant: variant as 'list', items };
    }
    case 'links':
      return { id: blockId, kind, variant: variant as 'buttons' };
    case 'quote':
      return {
        id: blockId,
        kind,
        variant: variant as 'plain',
        text: fit(v['text'], L.quoteText),
      };
    case 'about':
      return { id: blockId, kind, variant: 'plain' };
    case 'supporters':
      return STUDIO_SUPPORTER_WALL
        ? { id: blockId, kind, variant: 'names' }
        : null;
  }
}

function backgroundOf(v: unknown, twoColours: boolean): StudioRowBackground {
  if (
    isObj(v) &&
    Object.keys(v).length === 1 &&
    typeof v['photo'] === 'string' &&
    UUID.test(v['photo'])
  )
    return { photo: v['photo'] };
  const b = pick(v, STUDIO_BACKGROUNDS);
  return b === 'second' && !twoColours ? 'colour' : b;
}

function rowOf(v: Loose, twoColours: boolean, today: string): StudioRow {
  const rawCells = Array.isArray(v['cells']) ? v['cells'] : [];
  const columns = STUDIO_COLUMNS.includes(v['columns'] as StudioColumns)
    ? (v['columns'] as StudioColumns)
    : (['1', '1-1', '1-1-1'][
        Math.min(3, Math.max(1, rawCells.length)) - 1
      ] as StudioColumns);
  const cells = Array.from({ length: columnCount(columns) }, (_, i) =>
    (Array.isArray(rawCells[i]) ? (rawCells[i] as unknown[]) : [])
      .map((b) => blockOf(b, today))
      .filter((b): b is StudioBlock => b !== null)
      .slice(0, L.blocksPerCell),
  );
  return {
    id: typeof v['id'] === 'string' ? v['id'] : '',
    columns,
    spacing: pick(v['spacing'], STUDIO_SPACINGS),
    background: backgroundOf(v['background'], twoColours),
    cells,
  };
}

/** Page-wide limits, in reading order: whatever comes later is trimmed first. */
function withinLimits(rows: StudioRow[]): StudioRow[] {
  const left: Record<
    'blocks' | 'images' | 'videos' | 'events' | 'services' | 'about' | 'links',
    number
  > = {
    blocks: L.blocks,
    images: L.pageImages,
    videos: L.videos,
    events: L.events,
    services: L.services,
    about: 1,
    links: 1,
  };
  const take = (key: keyof typeof left, n = 1) => {
    if (left[key] < n) return false;
    left[key] -= n;
    return true;
  };
  return rows.map((row) => {
    const background =
      typeof row.background === 'object' && !take('images')
        ? 'page'
        : row.background;
    const cells = row.cells.map((cell) =>
      cell.flatMap((b): StudioBlock[] => {
        if (left.blocks < 1) return [];
        let next: StudioBlock = b;
        if (b.kind === 'photo' && !take('images')) return [];
        if (b.kind === 'video' && !take('videos')) return [];
        if ((b.kind === 'about' || b.kind === 'links') && !take(b.kind))
          return [];
        if (b.kind === 'gallery') {
          const n = Math.min(b.images.length, left.images);
          left.images -= n;
          next = { ...b, images: b.images.slice(0, n) };
        }
        if (b.kind === 'events' || b.kind === 'services') {
          const key = b.kind;
          const n = Math.min(b.items.length, left[key]);
          left[key] -= n;
          next = { ...b, items: b.items.slice(0, n) } as StudioBlock;
        }
        take('blocks');
        return [next];
      }),
    );
    return { ...row, background, cells };
  });
}

/** Keeps each valid id the first time it appears; gives every other row and block a new one. */
function withIds(rows: StudioRow[]): StudioRow[] {
  const seen = new Set<string>();
  const keep = (each: string) => {
    if (!ID.test(each) || seen.has(each)) return false;
    seen.add(each);
    return true;
  };
  const kept = rows.map((row) => ({
    row: keep(row.id),
    blocks: row.cells.map((cell) => cell.map((b) => keep(b.id))),
  }));
  let n = 0;
  const fresh = () => {
    let candidate: string;
    do candidate = `n${(n++).toString(36).padStart(7, '0')}`;
    while (seen.has(candidate));
    seen.add(candidate);
    return candidate;
  };
  return rows.map((row, r) => ({
    ...row,
    id: kept[r]?.row ? row.id : fresh(),
    cells: row.cells.map((cell, c) =>
      cell.map((b, k) => (kept[r]?.blocks[c]?.[k] ? b : { ...b, id: fresh() })),
    ),
  }));
}

function resolve(raw: unknown, today: string): StudioDocument {
  const o = isObj(raw) ? raw : {};
  const brand = brandOf(o['brand']);
  const rows = (Array.isArray(o['rows']) ? o['rows'] : [])
    .filter(isObj)
    .slice(0, L.rows)
    .map((row) => rowOf(row, brand.length === 2, today));
  return {
    v: 1,
    brand,
    mode: pick(o['mode'], STUDIO_MODES),
    fonts: fontsOf(o['fonts']),
    scale: pick(o['scale'], STUDIO_SCALES),
    corners: pick(o['corners'], STUDIO_CORNERS),
    rows: withIds(withinLimits(rows)),
  };
}

const EMPTY: StudioDocument = {
  v: 1,
  brand: ['#7a32f9'],
  mode: 'light',
  fonts: { ...STUDIO_DEFAULT_FONTS },
  scale: 'standard',
  corners: 'soft',
  rows: [],
};

/**
 * A stored document as a page can show it. Never throws. Retired fonts become the defaults, an
 * unusable colour becomes TipMe purple, unknown choices become the first allowed one, unknown
 * blocks are dropped, lists and rows past a limit are trimmed from the end, and events before
 * `today` (the Lagos date, YYYY-MM-DD) are hidden. A valid document comes back unchanged.
 */
export function resolveStudio(raw: unknown, today: string): StudioDocument {
  try {
    return resolve(raw, today);
  } catch {
    return structuredClone(EMPTY);
  }
}

/** A starter page that passes the design check: the bio and social links if there are any. */
export function defaultStudioDocument(profile: {
  bio?: string | null;
  links: number;
}): StudioDocument {
  const rows: StudioRow[] = [];
  const row = (n: number, block: StudioBlock): StudioRow => ({
    id: `row0000${n}`,
    columns: '1',
    spacing: 'm',
    background: 'page',
    cells: [[block]],
  });
  if (profile.bio)
    rows.push(row(1, { id: 'blk00001', kind: 'about', variant: 'plain' }));
  if (profile.links > 0)
    rows.push(row(2, { id: 'blk00002', kind: 'links', variant: 'buttons' }));
  if (rows.length === 0)
    rows.push(
      row(3, {
        id: 'blk00003',
        kind: 'text',
        variant: 'lead',
        text: 'Thank you for visiting my page.',
      }),
    );
  return { ...structuredClone(EMPTY), rows };
}
