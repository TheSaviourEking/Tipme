import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSinglePlaceRedirect } from '../src/lib/business/single-place.ts';

// The business page with one open place sends people straight to it (BusinessProfile board,
// approved 6 Nov 2026): decided in Proxy, so it is a real 307 rather than a streamed page.

const answer = (locations) => ({
  status: 200,
  body: {
    data: {
      business: { slug: 'mama-put', name: 'Mama Put', verified: true },
      locations: locations.map((slug) => ({ slug, name: slug, address: 'x' })),
    },
  },
});

function lookups(responses) {
  const asked = [];
  const lookup = async (slug) => {
    asked.push(slug);
    const next = responses[slug] ?? { status: 404, body: null };
    if (next instanceof Error) throw next;
    return next;
  };
  return { asked, lookup };
}

test('one open place: the location page, keeping only the QR marker', async () => {
  const { lookup } = lookups({ 'mama-put': answer(['yaba']) });
  const target = createSinglePlaceRedirect(lookup);
  assert.equal(
    await target('/b/mama-put', new URLSearchParams()),
    '/b/mama-put/yaba',
  );
  assert.equal(
    await target('/b/Mama-Put/', new URLSearchParams('src=qr&next=evil')),
    '/b/mama-put/yaba?src=qr',
  );
});

test('two places, none, unknown, a failure or another path: no redirect', async () => {
  const { asked, lookup } = lookups({
    two: answer(['vi', 'lekki']),
    broken: new Error('down'),
    odd: { status: 200, body: { data: { locations: [{ slug: '../x' }] } } },
  });
  const target = createSinglePlaceRedirect(lookup);
  const none = new URLSearchParams();
  for (const path of ['/b/two', '/b/missing', '/b/broken', '/b/odd'])
    assert.equal(await target(path, none), null, path);
  for (const path of ['/b/two/vi', '/b', '/b/', '/b/bad_slug', '/@ada', '/'])
    assert.equal(await target(path, none), null, path);
  // Only business pages are ever looked up.
  assert.deepEqual(asked, ['two', 'missing', 'broken', 'odd']);
});

test('an answer is reused for half a minute, then asked again', async () => {
  let now = 0;
  const { asked, lookup } = lookups({ 'mama-put': answer(['yaba']) });
  const target = createSinglePlaceRedirect(lookup, () => now);
  const none = new URLSearchParams();
  await target('/b/mama-put', none);
  now = 29_000;
  await target('/b/mama-put', none);
  assert.equal(asked.length, 1);
  now = 31_000;
  await target('/b/mama-put', none);
  assert.equal(asked.length, 2);
});
