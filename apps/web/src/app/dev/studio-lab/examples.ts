/**
 * Page Studio lab examples (plan Task 6). Kemi, Sule and Ify are the StudioExamples board, the same
 * documents as packages/contracts/test/fixtures/studio-examples.mjs (scripts/studio-lab.test.mjs
 * holds the two equal). The others push the renderer: every limit, the least, nothing, hostile
 * text, and a specimen per font. Sample people and generated images only.
 */
import {
  STUDIO_FONTS,
  STUDIO_LIMITS as L,
  migrateStudioV1,
  resolveStudioV1,
  type StudioDocument,
  type StudioStyleId,
  type StudioBlockV1,
  type StudioDocumentV1,
  type StudioFontId,
  type StudioRowV1,
} from '@tipme/contracts';

/** The lab's image ids, the same as the contracts test pool. */
export const LAB_IMAGES = Array.from(
  { length: 30 },
  (_, i) =>
    `0000${i.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`,
);
const [STAGE, CUT1, CUT2, CUT3, CUT4, CUT5, CUT6, SHOP] = LAB_IMAGES as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const kemi: StudioDocumentV1 = {
  v: 1,
  brand: ['#1d4e89', '#ff7a59'],
  mode: 'dark',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows: [
    {
      id: 'kemirow1',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'kemiblk1',
            kind: 'text',
            variant: 'lead',
            text: 'Every tip goes into studio time for the next record. New single out in December.',
          },
        ],
      ],
    },
    {
      id: 'kemirow2',
      columns: '1-1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'kemiblk2',
            kind: 'photo',
            variant: 'wide',
            imageId: STAGE,
            alt: 'Kemi singing at a studio night in Yaba',
            caption: 'Studio night, Yaba',
          },
        ],
        [
          {
            id: 'kemiblk3',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'Events',
          },
          {
            id: 'kemiblk4',
            kind: 'events',
            variant: 'list',
            items: [
              {
                date: '2026-11-15',
                time: '20:00',
                title: 'Live set, Lekki',
                place: 'Hard Rock Cafe',
              },
              {
                date: '2026-11-28',
                time: '19:00',
                title: 'Acoustic evening',
                place: 'Terra Kulture',
              },
            ],
          },
        ],
      ],
    },
    {
      id: 'kemirow3',
      columns: '1',
      spacing: 'm',
      background: 'card',
      cells: [
        [
          {
            id: 'kemiblk5',
            kind: 'text',
            variant: 'heading',
            level: 3,
            text: 'Watch',
          },
          {
            id: 'kemiblk6',
            kind: 'video',
            variant: 'still',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            caption: '“Lagos Rain”',
          },
        ],
      ],
    },
    {
      id: 'kemirow4',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [[{ id: 'kemiblk7', kind: 'about', variant: 'plain' }]],
    },
  ],
};

const sule: StudioDocumentV1 = {
  v: 1,
  brand: ['#f5c400'],
  mode: 'light',
  fonts: { heading: 'space-grotesk', body: 'inter' },
  scale: 'standard',
  corners: 'square',
  rows: [
    {
      id: 'sulerow1',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'suleblk1',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'Services and prices',
          },
          {
            id: 'suleblk2',
            kind: 'services',
            variant: 'cards',
            items: [
              { name: 'Skin fade', detail: '45 minutes', priceMinor: '800000' },
              {
                name: 'Beard shape',
                detail: '20 minutes',
                priceMinor: '400000',
              },
              {
                name: 'Kids’ cut',
                detail: '30 minutes',
                priceMinor: '500000',
                from: true,
              },
            ],
          },
        ],
      ],
    },
    {
      id: 'sulerow2',
      columns: '1',
      spacing: 'm',
      background: 'colour',
      cells: [
        [
          {
            id: 'suleblk3',
            kind: 'quote',
            variant: 'band',
            text: 'Open Tue to Sat, 9 am to 7 pm. Walk-ins welcome.',
          },
        ],
      ],
    },
    {
      id: 'sulerow3',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'suleblk4',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'Recent cuts',
          },
          {
            id: 'suleblk5',
            kind: 'gallery',
            variant: 'grid',
            images: [CUT1, CUT2, CUT3, CUT4, CUT5, CUT6].map((imageId, i) => ({
              imageId,
              alt: `A finished cut, photo ${i + 1}`,
            })),
          },
        ],
      ],
    },
    {
      id: 'sulerow4',
      columns: '1',
      spacing: 'l',
      background: { photo: SHOP },
      cells: [
        [
          {
            id: 'suleblk6',
            kind: 'text',
            variant: 'heading',
            level: 3,
            text: 'Fades, Wuse 2',
          },
        ],
      ],
    },
  ],
};

const ify: StudioDocumentV1 = {
  v: 1,
  brand: ['#e0457b'],
  mode: 'light',
  fonts: { heading: 'nunito', body: 'nunito' },
  scale: 'roomy',
  corners: 'round',
  rows: [
    {
      id: 'ifyrow01',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [[{ id: 'ifyblk01', kind: 'links', variant: 'buttons' }]],
    },
    {
      id: 'ifyrow02',
      columns: '1',
      spacing: 'm',
      background: 'card',
      cells: [
        [
          {
            id: 'ifyblk02',
            kind: 'quote',
            variant: 'plain',
            text: 'Next stream: Friday 9 pm. Bring snacks.',
          },
        ],
      ],
    },
    {
      id: 'ifyrow03',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'ifyblk03',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'Thank you, Ọlá and everyone',
          },
          {
            id: 'ifyblk04',
            kind: 'text',
            variant: 'paragraph',
            text: 'Cosy games and loud laughs, live four nights a week.\n\nSay hi in chat.',
          },
        ],
      ],
    },
  ],
};

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

/** Every limit at once: 12 rows, 40 blocks, 24 photos, 3 videos, 6 events, 12 services, full text. */
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

const min = base([
  row(1, [
    [
      {
        id: 'min00001',
        kind: 'text',
        variant: 'heading',
        level: 2,
        text: 'Hi',
      },
    ],
  ]),
]);
const empty = base([]);

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

/** One page per font: the font as heading, and as text where the library allows it. */
export function fontSpecimen(fontId: StudioFontId): StudioDocumentV1 {
  const font = STUDIO_FONTS.find((f) => f.id === fontId) ?? STUDIO_FONTS[0]!;
  const body = font.roles.includes('body') ? font.id : 'inter';
  const text = (
    n: number,
    variant: 'heading' | 'lead' | 'paragraph',
    words: string,
  ): StudioBlockV1 =>
    variant === 'heading'
      ? {
          id: id('fnt', n),
          kind: 'text',
          variant,
          level: 2,
          text: words.normalize('NFC'),
        }
      : {
          id: id('fnt', n),
          kind: 'text',
          variant,
          text: words.normalize('NFC'),
        };
  return base(
    [
      row(1, [
        [
          text(1, 'heading', `${font.name}: Ọlápéjú, Ṣẹ́gun, Chukwuemeka Ụzọ`),
          text(
            2,
            'lead',
            'The quick brown fox jumps over the lazy dog. ₦12,500',
          ),
        ],
      ]),
      row(2, [
        [
          text(
            3,
            'paragraph',
            'Ẹ kú àbọ̀. Every tip goes into studio time. Ńdewo! “Quotes”, dashes – and — ellipses…',
          ),
          {
            id: id('fnt', 4),
            kind: 'quote',
            variant: 'plain',
            text: 'Thank you, Ọlá'.normalize('NFC'),
          },
        ],
      ]),
    ],
    { fonts: { heading: font.id, body } },
  );
}

export const STUDIO_EXAMPLES = {
  kemi,
  sule,
  ify,
  max,
  min,
  empty,
  hostile,
} as const;
export type StudioExampleName = keyof typeof STUDIO_EXAMPLES | 'fonts';

// ---------------------------------------------------------------------------------------------
// Page Studio styles (spec 2026-11-17-page-studio-styles, PR 2a): v2 documents.

/**
 * One example per style drawn so far: its default accent (`null`), its natural mode, "Your cover"
 * (the lab profile's generated cover photo), a text, a quote and three photos, with the profile's
 * links on. Headings start each section, as on the canvas. Each style PR adds its own.
 */
const styleExample = (
  style: StudioStyleId,
  mode: StudioDocument['mode'],
): StudioDocument => ({
  v: 2,
  style,
  accent: null,
  mode,
  cover: 'yours',
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
