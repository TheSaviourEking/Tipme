import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESIGN_CHECK_VERSION, studioTokens } from '@tipme/contracts';
import { studioFor } from '../src/lib/public-studio.ts';

// Which public pages show a published Page Studio design (styles spec §11, §12.5, §13).

const API = 'https://api.tipme.example';
const PID = '11111111-1111-4111-8111-111111111111';
const IMG = '22222222-2222-4222-8222-222222222222';
const LAB = '00000001-0000-4000-8000-000000000000';

const doc = (extra = {}) => ({
  v: 2,
  style: 'clear',
  accent: 'blue',
  mode: 'light',
  cover: 'yours',
  blocks: [
    { id: 'blk00001', kind: 'text', variant: 'heading', text: 'New single' },
    {
      id: 'blk00002',
      kind: 'gallery',
      images: [IMG, LAB].map((imageId) => ({ imageId, alt: 'On stage' })),
    },
  ],
  ...extra,
});
const studio = (document = doc(), images = {}) => ({
  document,
  palette: studioTokens(document.style, document.accent),
  images,
  checkVersion: DESIGN_CHECK_VERSION,
});
const profile = (extra = {}) => ({
  handle: 'kemi',
  displayName: 'Kemi Bello',
  role: 'Singer',
  plan: 'pro',
  ...extra,
});
const at = { apiOrigin: API, labImages: false };

test('studioFor returns null for a campaign link, for no studio, and for whatever studioShown hides', () => {
  assert.equal(studioFor(profile(), at), null);
  assert.equal(studioFor(profile({ studio: undefined }), at), null);
  const p = profile({ studio: studio() });
  assert.notEqual(studioFor(p, at), null);
  assert.equal(studioFor(p, { ...at, campaign: 'lekki' }), null);
  // Classic with every default is today's page, on any plan.
  const classic = doc({ style: 'classic', accent: null, blocks: [] });
  for (const plan of ['free', 'pro'])
    assert.equal(
      studioFor(profile({ plan, studio: studio(classic) }), at),
      null,
    );
  // A Free page whose design is only Pro extras on Classic: the standard page.
  const extras = doc({
    style: 'classic',
    accent: 'photo',
    blocks: [doc().blocks[1]],
  });
  assert.equal(
    studioFor(profile({ plan: 'free', studio: studio(extras) }), at),
    null,
  );
});

test('a v1 studio from an older API shows the standard page', () => {
  const v1 = {
    v: 1,
    brand: ['#1d4e89'],
    mode: 'light',
    fonts: { heading: 'manrope', body: 'inter' },
    scale: 'standard',
    corners: 'soft',
    rows: [],
  };
  const old = {
    document: v1,
    // The v1 palette engine is gone; an older API still sends a palette, which is ignored.
    palette: {},
    images: {},
    checkVersion: 2,
  };
  assert.equal(studioFor(profile({ studio: old }), at), null);
});

test('a stale answer can never put a Pro design on a Free page', () => {
  // A Pro style for a Free page: Classic with their choices, and Classic's own palette.
  const stage = doc({ style: 'stage', mode: 'dark' });
  const shown = studioFor(profile({ plan: 'free', studio: studio(stage) }), at);
  assert.equal(shown.document.style, 'classic');
  assert.equal(shown.document.accent, 'blue');
  assert.equal(shown.document.mode, 'dark');
  assert.deepEqual(shown.document.blocks, [doc().blocks[0]]);
  assert.deepEqual(shown.palette, studioTokens('classic', 'blue'));
  // A free style keeps its palette as sent when nothing changes.
  const sent = studio(doc({ blocks: [doc().blocks[0]] }));
  assert.equal(
    studioFor(profile({ plan: 'free', studio: sent }), at).palette,
    sent.palette,
  );
});

test('Studio photos load from the API; any other address, or a photo the design hides, is dropped', () => {
  const path = `/v1/studio-images/${PID}/${IMG}/3`;
  const images = {
    [IMG]: { path, width: 2400, height: 1600 },
    bad1: { path: 'https://evil.example/x', width: 1, height: 1 },
    bad2: { path: '//evil.example/x', width: 1, height: 1 },
    bad4: { path: `${path}/../../avatars`, width: 1, height: 1 },
  };
  const design = doc({
    blocks: [
      {
        id: 'blk00002',
        kind: 'gallery',
        images: [IMG, 'bad1', 'bad2', 'bad4'].map((imageId) => ({
          imageId,
          alt: '',
        })),
      },
    ],
  });
  assert.deepEqual(
    studioFor(profile({ studio: studio(design, images) }), at).images,
    {
      [IMG]: { path: `${API}${path}`, width: 2400, height: 1600 },
    },
  );
  // On Free the gallery is hidden, so its photo is not listed.
  assert.deepEqual(
    studioFor(
      profile({
        plan: 'free',
        studio: studio(
          { ...design, blocks: [doc().blocks[0], ...design.blocks] },
          images,
        ),
      }),
      at,
    ).images,
    {},
  );
});

test('the lab’s generated images are allowed only in a test build', () => {
  const lab = `/dev/studio-lab/image/${LAB}`;
  const p = profile({
    studio: studio(doc(), { [LAB]: { path: lab, width: 2400, height: 1600 } }),
  });
  assert.deepEqual(studioFor(p, at).images, {});
  assert.deepEqual(studioFor(p, { ...at, labImages: true }).images, {
    [LAB]: { path: lab, width: 2400, height: 1600 },
  });
});
