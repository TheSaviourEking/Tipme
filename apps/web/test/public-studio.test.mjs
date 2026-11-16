import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESIGN_CHECK_VERSION, deriveStudioPalette } from '@tipme/contracts';
import { identityFor, studioFor } from '../src/lib/public-studio.ts';

// Which public pages show a published Page Studio design (plan Task 8), and what TipMe's own
// identity block keeps beside it.

const API = 'https://api.tipme.example';
const PID = '11111111-1111-4111-8111-111111111111';
const IMG = '22222222-2222-4222-8222-222222222222';
const LAB = '00000001-0000-4000-8000-000000000000';

const doc = (blocks) => ({
  v: 1,
  brand: ['#1d4e89'],
  mode: 'light',
  fonts: { heading: 'manrope', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows: [
    {
      id: 'row1',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [blocks],
    },
  ],
});
const studio = (blocks, images = {}) => {
  const document = doc(blocks);
  return {
    document,
    palette: deriveStudioPalette(document.brand),
    images,
    checkVersion: DESIGN_CHECK_VERSION,
  };
};
const profile = (extra = {}) => ({
  handle: 'kemi',
  displayName: 'Kemi Bello',
  role: 'Singer',
  bio: 'Songs about home.',
  links: [{ platform: 'x', url: 'https://x.com/kemi' }],
  plan: 'pro',
  ...extra,
});
const at = { apiOrigin: API, labImages: false };

test('a page without a published design (switch off, Free, or none) shows the standard page', () => {
  assert.equal(studioFor(profile(), at), null);
  assert.equal(studioFor(profile({ studio: undefined }), at), null);
});

test('a campaign link keeps the standard page, Studio or not', () => {
  const p = profile({ studio: studio([]) });
  assert.notEqual(studioFor(p, at), null);
  assert.equal(studioFor(p, { ...at, campaign: 'lekki' }), null);
});

test('a Free page never shows a design, whatever the API sends', () => {
  assert.equal(
    studioFor(profile({ plan: 'free', studio: studio([]) }), at),
    null,
  );
});

test('Studio photos load from the API; any other address is dropped', () => {
  const path = `/v1/studio-images/${PID}/${IMG}/3`;
  const shown = studioFor(
    profile({
      studio: studio([], {
        [IMG]: { path, width: 2400, height: 1600 },
        bad1: { path: 'https://evil.example/x', width: 1, height: 1 },
        bad2: { path: '//evil.example/x', width: 1, height: 1 },
        bad3: { path: `/dev/studio-lab/image/${LAB}`, width: 1, height: 1 },
        bad4: { path: `${path}/../../avatars`, width: 1, height: 1 },
      }),
    }),
    at,
  );
  assert.deepEqual(shown.images, {
    [IMG]: { path: `${API}${path}`, width: 2400, height: 1600 },
  });
});

test('the lab’s generated images are allowed only in a test build', () => {
  const lab = `/dev/studio-lab/image/${LAB}`;
  const p = profile({
    studio: studio([], { [LAB]: { path: lab, width: 2400, height: 1600 } }),
  });
  assert.deepEqual(studioFor(p, at).images, {});
  assert.deepEqual(studioFor(p, { ...at, labImages: true }).images, {
    [LAB]: { path: lab, width: 2400, height: 1600 },
  });
});

test('the identity keeps name, photo, @username, role and badge; the bio and links move only into blocks that show them', () => {
  const about = { id: 'b1', kind: 'about', variant: 'plain' };
  const links = { id: 'b2', kind: 'links', variant: 'buttons' };
  const p = profile({ socials: { x: 'https://x.com/kemi' } });
  const both = identityFor(p, doc([about, links]));
  assert.equal(both.bio, undefined);
  assert.equal(both.links, undefined);
  assert.equal(both.socials, undefined);
  assert.equal(both.displayName, 'Kemi Bello');
  assert.equal(both.handle, 'kemi');
  assert.equal(both.role, 'Singer');
  assert.equal(both.plan, 'pro');
  // A design without those blocks keeps them in the identity: nothing the person shared is lost.
  const neither = identityFor(p, doc([]));
  assert.equal(neither.bio, 'Songs about home.');
  assert.deepEqual(neither.links, p.links);
  const onlyAbout = identityFor(p, doc([about]));
  assert.equal(onlyAbout.bio, undefined);
  assert.deepEqual(onlyAbout.links, p.links);
});
