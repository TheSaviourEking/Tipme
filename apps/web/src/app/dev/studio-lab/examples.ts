/**
 * Page Studio lab examples. `max` and `hostile` are v1 stress documents (every limit; long unbroken
 * words, emoji, right-to-left and Yoruba text) that the styles lab migrates to v2 (`labStyleExample`);
 * the v1 renderer and its other examples (Kemi, Sule, Ify, a specimen per font) went with PR 4b.
 * The style examples are v2. Sample people and generated images only.
 */
import {
  STUDIO_LIMITS as L,
  migrateStudioV1,
  resolveStudioV1,
  type StudioDocument,
  type StudioStyleId,
  type StudioBlockV1,
  type StudioDocumentV1,
  type StudioRowV1,
} from '@tipme/contracts';

/** The lab's image ids, the same as the contracts test pool. */
export const LAB_IMAGES = Array.from(
  { length: 30 },
  (_, i) =>
    `0000${i.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`,
);
// The generated photos the examples use (ids 0 to 3 and 7 of the pool).
const [STAGE, CUT1, CUT2, CUT3] = LAB_IMAGES as [
  string,
  string,
  string,
  string,
  ...string[],
];
const SHOP = LAB_IMAGES[7]!;

/** A block without its id, kind by kind. */
type BlockDraft = StudioBlockV1 extends infer B
  ? B extends StudioBlockV1
    ? Omit<B, 'id'>
    : never
  : never;

const id = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(8 - prefix.length, '0')}`;
const base = (
  rows: StudioRowV1[],
  extra: Partial<StudioDocumentV1> = {},
): StudioDocumentV1 => ({
  v: 1,
  brand: ['#7a32f9'],
  mode: 'light',
  fonts: { heading: 'manrope', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows,
  ...extra,
});
const row = (
  n: number,
  cells: StudioBlockV1[][],
  extra: Partial<StudioRowV1> = {},
): StudioRowV1 => ({
  id: id('row', n),
  columns: (['1', '1-1', '1-1-1'] as const)[cells.length - 1] ?? '1',
  spacing: 'm',
  background: 'page',
  cells,
  ...extra,
});
const fill = (n: number, word = 'Lorem') =>
  Array.from({ length: n }, () => word)
    .join(' ')
    .slice(0, n)
    .trim();

/** Every v1 limit at once: 12 rows, 40 blocks, 24 photos, 3 videos, 6 events, 12 services, full text. */
const max: StudioDocumentV1 = (() => {
  let b = 0;
  const blk = (block: BlockDraft) =>
    ({ ...block, id: id('mx', ++b) }) as StudioBlockV1;
  const heading = () =>
    blk({
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: fill(L.headingText, 'Heading'),
    });
  const para = () =>
    blk({
      kind: 'text',
      variant: 'paragraph',
      text: [fill(150), fill(150), fill(150), fill(144)].join('\n\n'),
    });
  const gallery = (from: number) =>
    blk({
      kind: 'gallery',
      variant: 'grid',
      images: LAB_IMAGES.slice(from, from + 8).map((imageId) => ({
        imageId,
        alt: fill(L.alt, 'Photo'),
      })),
    });
  const rows: StudioRowV1[] = [
    row(1, [[heading(), para()]]),
    row(2, [[gallery(0)], [gallery(8)]], { columns: '1-1' }),
    row(3, [[gallery(16)]]),
    row(4, [
      [
        blk({
          kind: 'services',
          variant: 'list',
          items: Array.from({ length: L.services }, (_, i) => ({
            name: fill(L.serviceName, 'Service'),
            detail: fill(L.serviceDetail, 'Detail'),
            priceMinor: String((i + 1) * 100_000),
            from: true as const,
          })),
        }),
      ],
    ]),
    row(5, [
      [
        blk({
          kind: 'events',
          variant: 'list',
          items: Array.from({ length: L.events }, () => ({
            date: '2099-12-31',
            time: '21:30',
            title: fill(L.eventTitle, 'Event'),
            place: fill(L.eventPlace, 'Place'),
            note: fill(L.eventNote, 'Note'),
          })),
        }),
      ],
    ]),
    row(
      6,
      [
        [
          blk({
            kind: 'video',
            variant: 'still',
            url: 'https://youtu.be/dQw4w9WgXcQ',
            caption: fill(L.caption, 'Video'),
          }),
        ],
        [
          blk({
            kind: 'video',
            variant: 'still',
            url: 'https://www.tiktok.com/@kemisings/video/7301234567890123456',
          }),
        ],
      ],
      { columns: '1-1' },
    ),
    row(
      7,
      [
        [
          blk({
            kind: 'video',
            variant: 'still',
            url: 'https://audiomack.com/kemisings/song/lagos-rain',
          }),
        ],
      ],
      { background: 'card' },
    ),
    row(
      8,
      [
        [
          blk({
            kind: 'quote',
            variant: 'band',
            text: fill(L.quoteText, 'Quote'),
          }),
          blk({
            kind: 'text',
            variant: 'lead',
            text: fill(L.leadText, 'Lead'),
          }),
        ],
      ],
      { background: 'colour' },
    ),
    row(9, [
      [
        blk({ kind: 'links', variant: 'buttons' }),
        blk({ kind: 'about', variant: 'plain' }),
      ],
    ]),
    row(
      10,
      [
        [para(), para(), para()],
        [para(), para(), para()],
      ],
      { columns: '1-1' },
    ),
    row(
      11,
      [
        [para(), heading(), para()],
        [para(), para(), para()],
      ],
      { columns: '1-1' },
    ),
    row(
      12,
      [
        [para(), para()],
        [para(), para()],
      ],
      { columns: '1-1', background: 'second' },
    ),
  ];
  return base(rows, { brand: ['#1d4e89', '#ff7a59'] });
})();

/** Long unbroken words, emoji, right-to-left and Yoruba text in every text place. */
const LONG = 'W'.repeat(60);
const hostile = base(
  [
    row(1, [
      [
        {
          id: 'hst00001',
          kind: 'text',
          variant: 'heading',
          level: 2,
          text: `${LONG.slice(0, 40)} Ọlápéjú Ẹ̀kọ́`.normalize('NFC'),
        },
        {
          id: 'hst00002',
          kind: 'text',
          variant: 'paragraph',
          text: `${LONG} 😀🎶🔥 مرحبا بكم שלום Ṣọlá\n\n${LONG}${LONG}`,
        },
      ],
    ]),
    row(
      2,
      [
        [
          {
            id: 'hst00003',
            kind: 'services',
            variant: 'cards',
            items: [
              {
                name: LONG.slice(0, L.serviceName),
                detail: LONG,
                priceMinor: '1000000000',
                from: true,
              },
            ],
          },
        ],
        [
          {
            id: 'hst00004',
            kind: 'events',
            variant: 'list',
            items: [
              {
                date: '2099-01-01',
                title: LONG,
                place: 'مرحبا بكم',
                note: LONG.slice(0, L.eventNote),
              },
            ],
          },
        ],
      ],
      { columns: '1-1' },
    ),
    row(
      3,
      [
        [
          {
            id: 'hst00005',
            kind: 'quote',
            variant: 'band',
            text: `${LONG} 😀`,
          },
          {
            id: 'hst00006',
            kind: 'photo',
            variant: 'circle',
            imageId: STAGE,
            alt: LONG,
            caption: LONG.slice(0, L.caption),
          },
        ],
      ],
      { background: { photo: SHOP } },
    ),
  ],
  {
    fonts: { heading: 'dm-serif-display', body: 'source-serif-4' },
    scale: 'roomy',
  },
);

// ---------------------------------------------------------------------------------------------
// Page Studio styles (spec 2026-11-17-page-studio-styles, PR 2a): v2 documents.

/**
 * One example per style: its default accent (`null`), its natural mode, its default cover ("Your
 * cover" is the lab profile's generated cover photo; Journal's, Signboard's and Tiles' are plain),
 * a text, a quote and three photos, with the profile's links on. Headings start each section, as
 * on the canvas.
 */
const styleExample = (
  style: StudioStyleId,
  mode: StudioDocument['mode'],
  cover: StudioDocument['cover'] = 'yours',
): StudioDocument => ({
  v: 2,
  style,
  accent: null,
  mode,
  cover,
  blocks: [
    { id: 'labhead1', kind: 'text', variant: 'heading', text: 'Studio diary' },
    {
      id: 'labtext1',
      kind: 'text',
      variant: 'paragraph',
      text: 'Eight songs, a four-piece band and a small room in Yaba. Tips pay for studio hours and the session players.',
    },
    {
      id: 'labgall1',
      kind: 'gallery',
      images: [CUT1, CUT2, CUT3].map((imageId, i) => ({
        imageId,
        alt: [
          'Rehearsal, warm stage light',
          'Vocal booth under blue light',
          'Morning session by the window',
        ][i]!,
      })),
    },
    { id: 'labhead2', kind: 'text', variant: 'heading', text: 'Kind words' },
    {
      id: 'labquot1',
      kind: 'quote',
      text: 'The best night of live music I’ve had in Lagos this year.',
    },
  ],
});

export const LAB_STYLE_EXAMPLES: Partial<
  Record<StudioStyleId, StudioDocument>
> = {
  classic: styleExample('classic', 'light'),
  clear: styleExample('clear', 'light'),
  // Journal's default cover is plain (§9.3): the page opens on its top row, as the board draws it.
  journal: styleExample('journal', 'light', 'plain'),
  linen: styleExample('linen', 'light'),
  // Stage is dark-first (§9.4); Horizon light (§9.9). Both open on "Your cover", the photo.
  stage: styleExample('stage', 'dark'),
  horizon: styleExample('horizon', 'light'),
  // Signboard opens on its band (plain, §9.5), Sprint on "Your cover" (§9.6), Tiles plain (§9.7).
  signboard: styleExample('signboard', 'light', 'plain'),
  sprint: styleExample('sprint', 'light'),
  tiles: styleExample('tiles', 'light', 'plain'),
  // Creator is dark-first (addendum §7.1), Professional light (§7.2); both on "Your cover".
  creator: styleExample('creator', 'dark'),
  professional: styleExample('professional', 'light'),
};

/** §9.10's long names, for `?example=long-names` (the first, unless `&name=` picks another). */
export const LAB_LONG_NAMES = [
  'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀',
  'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí',
  'Ɗanlami Ƙwairanga Ɓello',
] as const;

/** The v1 stress documents in v2 (§7.1's migration): every limit, the least, hostile text. */
const migrated = (doc: StudioDocumentV1, style: StudioStyleId) => ({
  ...migrateStudioV1(resolveStudioV1(doc, '2026-11-14')),
  style,
  accent: null,
  cover: 'yours' as const,
});

/** `?example=styles-min|styles-max|long-names|hostile` (`&style=` picks the style, Clear first). */
export function labStyleExample(
  name: string,
  style: StudioStyleId,
): StudioDocument | null {
  const base = LAB_STYLE_EXAMPLES[style];
  if (!base) return null;
  switch (name) {
    case 'styles-min':
      return { ...base, blocks: [] };
    case 'styles-max':
      return { ...migrated(max, style), mode: base.mode };
    case 'long-names':
      return base;
    case 'hostile':
      return { ...migrated(hostile, style), mode: base.mode };
    default:
      return null;
  }
}
