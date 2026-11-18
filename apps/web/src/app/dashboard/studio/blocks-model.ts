/**
 * Page Studio editor, PR G2 (plan 2026-11-12-page-studio, Task 9b): the Blocks tab's pure parts.
 * Plain TypeScript with no `@/` imports, so its unit test runs in Node (test/studio-blocks.test.mjs).
 * Every function returns a document the strict schema accepts (or says why it can't), so the
 * editor's debounced save never sends one the API would refuse. The API enforces the same limits.
 */
import {
  STUDIO_LIMITS as L,
  cleanStudioParagraph,
  cleanStudioText,
  columnCount,
  studioCounts,
  type StudioBlockV1,
  type StudioBlockKindV1,
  type StudioColumns,
  type StudioDocumentV1,
  type StudioIssue,
  type StudioRowV1,
  type StudioRowBackground,
  type StudioSpacing,
} from '@tipme/contracts';

type Kind = Exclude<StudioBlockKindV1, 'supporters'>;
type Block<K extends StudioBlockKindV1> = Extract<StudioBlockV1, { kind: K }>;

/** "Add a block", in the board's order; About comes back here once removed. */
export const ADD_KINDS: readonly { kind: Kind; label: string; hint: string }[] =
  [
    { kind: 'text', label: 'Text', hint: 'heading, intro, paragraph' },
    { kind: 'photo', label: 'Photo', hint: 'square, wide, tall, circle' },
    { kind: 'gallery', label: 'Gallery', hint: 'grid, strip, mosaic' },
    { kind: 'video', label: 'Video', hint: 'loads when tapped' },
    { kind: 'services', label: 'Services', hint: 'list, cards' },
    { kind: 'events', label: 'Events', hint: 'list, cards' },
    { kind: 'links', label: 'Links', hint: 'buttons, icons' },
    { kind: 'quote', label: 'Quote', hint: 'plain, band' },
    { kind: 'about', label: 'About', hint: 'your bio' },
  ];

export const KIND_LABEL: Record<StudioBlockKindV1, string> = {
  text: 'Text',
  photo: 'Photo',
  gallery: 'Gallery',
  video: 'Video',
  services: 'Services',
  events: 'Events',
  links: 'Links',
  quote: 'Quote',
  about: 'About',
  supporters: 'Supporters',
};

/** Each variant's words, for the choice at the top of a block's form. */
export const VARIANT_LABEL: Record<string, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  lead: 'Intro',
  square: 'Square',
  wide: 'Wide',
  tall: 'Tall',
  circle: 'Circle',
  grid: 'Grid',
  strip: 'Strip',
  mosaic: 'Mosaic',
  list: 'List',
  cards: 'Cards',
  buttons: 'Buttons',
  icons: 'Icons',
  plain: 'Plain',
  band: 'Band',
};

export const COLUMN_LABEL: Record<StudioColumns, string> = {
  '1': 'One column',
  '1-1': '1 : 1',
  '2-1': '2 : 1',
  '1-2': '1 : 2',
  '1-1-1': '1 : 1 : 1',
};

const codePoints = (s: string) => [...s].length;
const cut = (s: string, max: number) => [...s].slice(0, max).join('');
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Every row and block id on the page. */
function idsOf(doc: StudioDocumentV1): Set<string> {
  return new Set(
    doc.rows.flatMap((r) => [r.id, ...r.cells.flat().map((b) => b.id)]),
  );
}

/** A new id the page doesn't use yet (8 lower-case letters or digits, as the schema asks). */
export function freshId(
  doc: StudioDocumentV1,
  also: ReadonlySet<string> = new Set(),
): string {
  const used = idsOf(doc);
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = [...bytes].map((b) => abc[b % abc.length]).join('');
    if (!used.has(id) && !also.has(id)) return id;
  }
}

const mapRow = (
  doc: StudioDocumentV1,
  rowId: string,
  fn: (row: StudioRowV1) => StudioRowV1,
): StudioDocumentV1 => ({
  ...doc,
  rows: doc.rows.map((r) => (r.id === rowId ? fn(r) : r)),
});

// ---------------------------------------------------------------------------------------------
// Rows

/** Why no row can be added, or null. */
export function rowReason(doc: StudioDocumentV1): string | null {
  return doc.rows.length >= L.rows
    ? `Your page has ${L.rows} rows, the most it can have.`
    : null;
}

/** A new empty row at the end (one column, page background); unchanged at the limit. */
export function addRow(doc: StudioDocumentV1): StudioDocumentV1 {
  if (rowReason(doc)) return doc;
  return {
    ...doc,
    rows: [
      ...doc.rows,
      {
        id: freshId(doc),
        columns: '1',
        spacing: 'm',
        background: 'page',
        cells: [[]],
      },
    ],
  };
}

export function removeRow(
  doc: StudioDocumentV1,
  rowId: string,
): StudioDocumentV1 {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) };
}

/** The row at `from` moved to `to`; unchanged when either is off the list or they are equal. */
export function moveRow(
  doc: StudioDocumentV1,
  from: number,
  to: number,
): StudioDocumentV1 {
  const n = doc.rows.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return doc;
  const rows = [...doc.rows];
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved!);
  return { ...doc, rows };
}

/** What the live region says after a move (plan Task 9: "Row 3, moved to position 1 of 5"). */
export const movedWords = (from: number, to: number, total: number) =>
  `Row ${from + 1}, moved to position ${to + 1} of ${total}`;

/**
 * The row with a new column split. More columns add empty ones; fewer move the blocks of the
 * dropped columns into the ones kept, in reading order. Returns the reason when they don't fit.
 */
export function withColumns(
  doc: StudioDocumentV1,
  rowId: string,
  columns: StudioColumns,
): StudioDocumentV1 | string {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) return doc;
  const n = columnCount(columns);
  const blocks = row.cells.flat();
  if (blocks.length > n * L.blocksPerCell) {
    const over = blocks.length - n * L.blocksPerCell;
    return `This row has ${blocks.length} blocks, and ${n === 1 ? 'one column holds' : `${n} columns hold`} ${n * L.blocksPerCell}. Remove ${plural(over, 'block')} or move them to another row first.`;
  }
  const cells: StudioBlockV1[][] = Array.from({ length: n }, (_, i) => [
    ...(row.cells[i] ?? []),
  ]);
  for (const block of row.cells.slice(n).flat()) {
    const room = cells.find((c) => c.length < L.blocksPerCell)!;
    room.push(block);
  }
  return mapRow(doc, rowId, (r) => ({ ...r, columns, cells }));
}

export const withSpacing = (
  doc: StudioDocumentV1,
  rowId: string,
  spacing: StudioSpacing,
) => mapRow(doc, rowId, (r) => ({ ...r, spacing }));

export const withBackground = (
  doc: StudioDocumentV1,
  rowId: string,
  background: StudioRowBackground,
) => mapRow(doc, rowId, (r) => ({ ...r, background }));

/** "2 : 1 · 3 blocks", the row's line in the rows list. */
export function rowSummary(row: StudioRowV1): string {
  const n = row.cells.flat().length;
  return `${COLUMN_LABEL[row.columns]} · ${n === 0 ? 'empty' : plural(n, 'block')}`;
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** A new block with nothing in it yet; a photo needs its image and a video its link. */
export function newBlock(
  kind: Kind,
  id: string,
  given: { imageId?: string; url?: string } = {},
): StudioBlockV1 {
  switch (kind) {
    case 'text':
      return { id, kind, variant: 'paragraph', text: '' };
    case 'photo':
      return {
        id,
        kind,
        variant: 'square',
        imageId: given.imageId ?? '',
        alt: '',
      };
    case 'gallery':
      return { id, kind, variant: 'grid', images: [] };
    case 'video':
      return { id, kind, variant: 'still', url: given.url ?? '' };
    case 'services':
      return { id, kind, variant: 'list', items: [] };
    case 'events':
      return { id, kind, variant: 'list', items: [] };
    case 'links':
      return { id, kind, variant: 'buttons' };
    case 'quote':
      return { id, kind, variant: 'plain', text: '' };
    case 'about':
      return { id, kind, variant: 'plain' };
  }
}

/**
 * Why each kind can't be added to this column now: `all` when nothing can, otherwise by kind.
 * The same limits the schema and the API enforce (owner ruling 3).
 */
export function addReasons(
  doc: StudioDocumentV1,
  rowId: string,
  cell: number,
  profile: { bio: boolean; links: number },
): Partial<Record<Kind | 'all', string>> {
  const row = doc.rows.find((r) => r.id === rowId);
  const c = studioCounts(doc);
  if ((row?.cells[cell]?.length ?? 0) >= L.blocksPerCell)
    return {
      all: `This column has ${L.blocksPerCell} blocks, the most one column can hold.`,
    };
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
  if (c.about > 0) out.about = 'About is already on your page. It shows once.';
  else if (!profile.bio)
    out.about = 'Add a bio in My page first. About shows it.';
  if (c.links > 0)
    out.links = 'Your links are already on your page. They show once.';
  else if (profile.links === 0)
    out.links = 'Add your links in My page first. This block shows them.';
  return out;
}

export function addBlock(
  doc: StudioDocumentV1,
  rowId: string,
  cell: number,
  block: StudioBlockV1,
): StudioDocumentV1 {
  return mapRow(doc, rowId, (r) => ({
    ...r,
    cells: r.cells.map((c, i) => (i === cell ? [...c, block] : c)),
  }));
}

/** Where a block is: row index, column and place in the column. */
export function findBlock(doc: StudioDocumentV1, blockId: string) {
  for (const [r, row] of doc.rows.entries())
    for (const [c, cell] of row.cells.entries()) {
      const k = cell.findIndex((b) => b.id === blockId);
      if (k >= 0) return { r, c, k, row, block: cell[k]! };
    }
  return null;
}

export function removeBlock(
  doc: StudioDocumentV1,
  blockId: string,
): StudioDocumentV1 {
  return {
    ...doc,
    rows: doc.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => c.filter((b) => b.id !== blockId)),
    })),
  };
}

export function updateBlock(
  doc: StudioDocumentV1,
  blockId: string,
  fn: (block: StudioBlockV1) => StudioBlockV1,
): StudioDocumentV1 {
  return {
    ...doc,
    rows: doc.rows.map((r) =>
      r.cells.some((c) => c.some((b) => b.id === blockId))
        ? {
            ...r,
            cells: r.cells.map((c) =>
              c.map((b) => (b.id === blockId ? fn(b) : b)),
            ),
          }
        : r,
    ),
  };
}

export type BlockMove = 'up' | 'down' | 'left' | 'right';

/**
 * Up and down within its column; left and right to the end of the next column. Null when it
 * can't go there (an end, or a full column).
 */
export function moveBlock(
  doc: StudioDocumentV1,
  blockId: string,
  to: BlockMove,
): StudioDocumentV1 | null {
  const at = findBlock(doc, blockId);
  if (!at) return null;
  const cells = at.row.cells.map((c) => [...c]);
  const cell = cells[at.c]!;
  if (to === 'up' || to === 'down') {
    const k = at.k + (to === 'up' ? -1 : 1);
    if (k < 0 || k >= cell.length) return null;
    [cell[at.k], cell[k]] = [cell[k]!, cell[at.k]!];
  } else {
    const target = cells[at.c + (to === 'left' ? -1 : 1)];
    if (!target || target.length >= L.blocksPerCell) return null;
    cell.splice(at.k, 1);
    target.push(at.block);
  }
  return mapRow(doc, at.row.id, (r) => ({ ...r, cells }));
}

/** A text block in another style, its words fitted to that style's limit and line rules. */
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
  const max = variant === 'heading' ? L.headingText : L.leadText;
  const text = cleanStudioText(cut(cleanStudioText(block.text), max));
  return variant === 'heading'
    ? { id: block.id, kind: 'text', variant, level: block.level ?? 2, text }
    : { id: block.id, kind: 'text', variant, text };
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

/** The block's line in its column: its first words, or what it holds. */
export function blockSummary(block: StudioBlockV1): string {
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
    case 'links':
      return 'Your links from My page';
    case 'about':
      return 'Your bio from My page';
    case 'supporters':
      return 'Supporters';
  }
}

/** True when removing the block would lose something the person wrote or chose. */
export function hasContent(block: StudioBlockV1): boolean {
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
// Design check fixes that need the person's input (G1 hid them; they open the form here)

export type FixField = 'photo' | 'background' | 'link' | 'alt' | 'text';

/** Where a fix needing input takes the person, or null for a one-click fix. */
export function fixTarget(
  issue: StudioIssue,
  fixId: string,
): { row: string; block?: string; field: FixField } | null {
  const { row, block } = issue.at;
  const field: FixField | null =
    fixId === 'replace-photo'
      ? block
        ? 'photo'
        : 'background'
      : fixId === 'change-link'
        ? 'link'
        : fixId === 'add-description'
          ? 'alt'
          : fixId === 'edit-text'
            ? 'text'
            : null;
  if (!field || !row) return null;
  return block ? { row, block, field } : { row, field };
}
