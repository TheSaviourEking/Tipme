/**
 * Page Studio's Blocks tab on v2 (styles spec §10, "The Blocks tab"; plan Task 12, PR 4a): its pure
 * parts. Plain TypeScript with no `@/` imports, so its unit test runs in Node
 * (test/studio-blocks.test.mjs). The page is one ordered list of blocks; the style decides how
 * each looks, so there are no columns, spacing, backgrounds or variants. Every function returns a
 * document the strict schema accepts (or says why it can't), so the editor's debounced save never
 * sends one the API would refuse. The API enforces the same limits.
 */
import {
  STUDIO_LIMITS as L,
  STUDIO_PRO_BLOCKS,
  cleanStudioParagraph,
  cleanStudioText,
  type StudioBlock,
  type StudioBlockKind,
  type StudioDocument,
  type StudioIssue,
} from '@tipme/contracts';

type Kind = Exclude<StudioBlockKind, 'supporters'>;
type Block<K extends StudioBlockKind> = Extract<StudioBlock, { kind: K }>;

export const KIND_LABEL: Record<StudioBlockKind, string> = {
  text: 'Text',
  photo: 'Photo',
  gallery: 'Gallery',
  video: 'Video',
  services: 'Services',
  events: 'Events',
  quote: 'Quote',
  supporters: 'Supporters',
};

/** "Add a block", in order. Links is not a block (profile links are fixed, §8), nor About. */
const KINDS: readonly { kind: Kind; hint: string }[] = [
  { kind: 'text', hint: 'a heading or a paragraph' },
  { kind: 'photo', hint: 'one photo' },
  { kind: 'gallery', hint: `up to ${L.galleryImages} photos` },
  { kind: 'video', hint: 'loads when tapped' },
  { kind: 'services', hint: 'what you offer, with prices' },
  { kind: 'events', hint: 'dates and places' },
  { kind: 'quote', hint: 'a line someone said' },
];

/** The kinds to add, each marked `pro` (the PRO badge) for a Free page (§10, §11). */
export function addKinds(
  plan: 'free' | 'pro',
): { kind: Kind; label: string; hint: string; pro: boolean }[] {
  return KINDS.map(({ kind, hint }) => ({
    kind,
    label: KIND_LABEL[kind],
    hint,
    pro: plan !== 'pro' && STUDIO_PRO_BLOCKS.includes(kind),
  }));
}

const FIXED = 'Always TipMe. Can’t be moved or removed.';

/**
 * TipMe's own parts, shown as locked rows above the blocks (§10): the cover, name and bio, then
 * the Tip, then the profile links, only when there are some.
 */
export function lockedRows(
  links: number,
): { key: 'identity' | 'tip' | 'links'; title: string; detail: string }[] {
  return [
    { key: 'identity', title: 'Cover, name and bio', detail: FIXED },
    { key: 'tip', title: 'Tip', detail: FIXED },
    ...(links > 0
      ? [
          {
            key: 'links' as const,
            title: 'Your links',
            detail: `${FIXED} Change them in Settings.`,
          },
        ]
      : []),
  ];
}

const codePoints = (s: string) => [...s].length;
const cut = (s: string, max: number) => [...s].slice(0, max).join('');
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A new id the page doesn't use yet (8 lower-case letters or digits, as the schema asks). */
export function freshId(
  doc: StudioDocument,
  also: ReadonlySet<string> = new Set(),
): string {
  const used = new Set(doc.blocks.map((b) => b.id));
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = [...bytes].map((b) => abc[b % abc.length]).join('');
    if (!used.has(id) && !also.has(id)) return id;
  }
}

/** A new block with nothing in it yet; a photo needs its image and a video its link. */
export function newBlock(
  kind: Kind,
  id: string,
  given: { imageId?: string; url?: string } = {},
): StudioBlock {
  switch (kind) {
    case 'text':
      return { id, kind, variant: 'paragraph', text: '' };
    case 'photo':
      return { id, kind, imageId: given.imageId ?? '', alt: '' };
    case 'gallery':
      return { id, kind, images: [] };
    case 'video':
      return { id, kind, url: given.url ?? '' };
    case 'services':
      return { id, kind, items: [] };
    case 'events':
      return { id, kind, items: [] };
    case 'quote':
      return { id, kind, text: '' };
  }
}

/** What the page holds against its limits (studio-limits.ts). */
export function blockCounts(doc: StudioDocument) {
  const c = { blocks: doc.blocks.length, images: 0, videos: 0, events: 0 };
  let services = 0;
  for (const b of doc.blocks) {
    if (b.kind === 'photo') c.images += 1;
    if (b.kind === 'gallery') c.images += b.images.length;
    if (b.kind === 'video') c.videos += 1;
    if (b.kind === 'events') c.events += b.items.length;
    if (b.kind === 'services') services += b.items.length;
  }
  return { ...c, services };
}

/**
 * Why each kind can't be added now: `all` when nothing can, otherwise by kind. The same limits the
 * schema and the API enforce.
 */
export function addReasons(
  doc: StudioDocument,
): Partial<Record<Kind | 'all', string>> {
  const c = blockCounts(doc);
  if (c.blocks >= L.blocks)
    return { all: `Your page has ${L.blocks} blocks, the most it can have.` };
  const out: Partial<Record<Kind, string>> = {};
  const photos = `Your page has ${L.pageImages} photos, the most it can have.`;
  if (c.images >= L.pageImages) {
    out.photo = photos;
    out.gallery = photos;
  }
  if (c.videos >= L.videos)
    out.video = `Your page has ${L.videos} videos, the most it can have.`;
  if (c.services >= L.services)
    out.services = `Your page has ${L.services} services, the most it can have.`;
  if (c.events >= L.events)
    out.events = `Your page has ${L.events} events, the most it can have.`;
  return out;
}

/** The block added at the end of the page. */
export const addBlock = (
  doc: StudioDocument,
  block: StudioBlock,
): StudioDocument => ({ ...doc, blocks: [...doc.blocks, block] });

export const removeBlock = (
  doc: StudioDocument,
  blockId: string,
): StudioDocument => ({
  ...doc,
  blocks: doc.blocks.filter((b) => b.id !== blockId),
});

export function updateBlock(
  doc: StudioDocument,
  blockId: string,
  fn: (block: StudioBlock) => StudioBlock,
): StudioDocument {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.id === blockId ? fn(b) : b)),
  };
}

/** One place up or down; null at an end. */
export function moveBlock(
  doc: StudioDocument,
  blockId: string,
  to: 'up' | 'down',
): StudioDocument | null {
  const at = doc.blocks.findIndex((b) => b.id === blockId);
  if (at < 0) return null;
  const k = at + (to === 'up' ? -1 : 1);
  if (k < 0 || k >= doc.blocks.length) return null;
  return moveBlockTo(doc, at, k);
}

/** The block at `from` moved to `to` (a drag); unchanged when either is off the list or equal. */
export function moveBlockTo(
  doc: StudioDocument,
  from: number,
  to: number,
): StudioDocument {
  const n = doc.blocks.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return doc;
  const blocks = [...doc.blocks];
  const [moved] = blocks.splice(from, 1);
  blocks.splice(to, 0, moved!);
  return { ...doc, blocks };
}

/** What the live region says after a move, in G2's words: "Text, moved to place 2 of 5". */
export const movedWords = (
  kind: StudioBlockKind,
  index: number,
  total: number,
) => `${KIND_LABEL[kind]}, moved to place ${index + 1} of ${total}`;

/** A text block as a heading or a paragraph, its words fitted to that kind's limit and line rules. */
export function textVariant(
  block: Block<'text'>,
  variant: Block<'text'>['variant'],
): Block<'text'> {
  if (variant === 'paragraph')
    return {
      id: block.id,
      kind: 'text',
      variant,
      text: cleanStudioParagraph(cut(block.text, L.paragraphText)),
    };
  return {
    id: block.id,
    kind: 'text',
    variant,
    text: cleanStudioText(cut(cleanStudioText(block.text), L.headingText)),
  };
}

/** "212 of 600": characters as people see them (code points), as the limits count them. */
export const counter = (text: string, max: number) =>
  `${codePoints(text)} of ${max}`;

/** A form's words as stored: cleaned, then cut to the limit (cleaning again, as a cut can end in a space). */
export function fitText(raw: string, max: number, paragraph = false): string {
  const clean = paragraph ? cleanStudioParagraph : cleanStudioText;
  return clean(cut(clean(raw), max));
}

/** Whole naira as typed ("₦5,000", "5000") → kobo, as stored; null for anything else. */
export function nairaToKobo(input: string): string | null {
  const raw = input.trim().replace(/^₦/, '').replace(/,/g, '').trim();
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const kobo = BigInt(raw) * BigInt(100);
  return kobo <= L.priceMaxMinor ? kobo.toString() : null;
}

/** "500000" → "5,000". */
export const koboToNaira = (kobo: string) =>
  (BigInt(kobo) / BigInt(100)).toLocaleString('en-NG');

/** The block's line in the list: its first words, or what it holds. */
export function blockSummary(block: StudioBlock): string {
  switch (block.kind) {
    case 'text':
    case 'quote':
      return block.text ? cut(block.text.split('\n')[0]!, 48) : 'No words yet';
    case 'photo':
      return (
        block.alt ||
        (block.decorative ? 'Decorative photo' : 'No description yet')
      );
    case 'gallery':
      return block.images.length
        ? plural(block.images.length, 'photo')
        : 'No photos yet';
    case 'video':
      return block.url;
    case 'services':
      return block.items.length
        ? plural(block.items.length, 'service')
        : 'No services yet';
    case 'events':
      return block.items.length
        ? plural(block.items.length, 'event')
        : 'No events yet';
    case 'supporters':
      return 'Supporters';
  }
}

/** True when removing the block would lose something the person wrote or chose. */
export function hasContent(block: StudioBlock): boolean {
  switch (block.kind) {
    case 'text':
    case 'quote':
      return block.text.length > 0;
    case 'gallery':
      return block.images.length > 0;
    case 'services':
    case 'events':
      return block.items.length > 0;
    case 'photo':
    case 'video':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Design check fixes that need the person's input: they open the block's form at the field

export type FixField = 'photo' | 'link' | 'alt' | 'text';

/** Where a fix needing input takes the person, or null (a one-click fix, or a page-level one). */
export function fixTarget(
  issue: Pick<StudioIssue, 'at'>,
  fixId: string,
): { block: string; field: FixField } | null {
  const { block } = issue.at;
  const field: FixField | null =
    fixId === 'replace-photo'
      ? 'photo'
      : fixId === 'change-link'
        ? 'link'
        : fixId === 'add-description'
          ? 'alt'
          : fixId === 'shorter-heading' || fixId === 'edit-text'
            ? 'text'
            : null;
  return field && block ? { block, field } : null;
}
