// The three pages on the StudioExamples board (Kemi, Sule, Ify), as Studio documents. Each must
// pass the design check. Task 6 renders the same three in CI. Sample people and content.
import { IMAGE_POOL, imageFacts } from '../support/studio-arbitrary.mjs';

const [STAGE, CUT1, CUT2, CUT3, CUT4, CUT5, CUT6, SHOP] = IMAGE_POOL;

export const KEMI = {
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

export const SULE = {
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

export const IFY = {
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

/** Server facts for the examples: every photo 2400 by 1600, every video live, a bio and 4 links. */
export const EXAMPLE_CONTEXT = {
  images: Object.fromEntries(
    IMAGE_POOL.map((id) => [id, imageFacts({ width: 2400, height: 1600 })]),
  ),
  videos: { 'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'ok' },
  profile: { bio: true, links: 4 },
};
