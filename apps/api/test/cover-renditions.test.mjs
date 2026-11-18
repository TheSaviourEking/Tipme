import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { COVER_RENDITION_WIDTHS, COVER_TALL_WIDTHS } from '@tipme/contracts';
import { reencodeTo } from '../dist/profiles/image-upload.js';
import {
  coverRenditionsOf,
  renditionFile,
  tallCropRegion,
  tallCropWidths,
  toCover,
} from '../dist/profiles/cover-renditions.js';
import { photoLike } from './photo-like.mjs';

// Cover renditions (Studio styles spec §9.4/§9.9): the stored 2240×600 cover at 640, 1080 and
// 1600 wide, same shape, WebP, no metadata, never upscaled. Measured on a generated photo only.

test('a cover gets every rendition width, same shape, small enough for a phone', async () => {
  const full = await toCover(await photoLike());
  const meta = await sharp(full).metadata();
  assert.deepEqual([meta.width, meta.height], [2240, 600]);
  const renditions = (await coverRenditionsOf(full)).filter(
    (r) => r.shape === 'wide',
  );
  assert.deepEqual(
    renditions.map((r) => r.width),
    [...COVER_RENDITION_WIDTHS],
  );
  const sizes = { full: full.length };
  for (const r of renditions) {
    const m = await sharp(r.webp).metadata();
    assert.equal(m.format, 'webp');
    assert.equal(m.width, r.width);
    assert.equal(m.height, Math.round((r.width * 600) / 2240));
    assert.equal(m.exif, undefined);
    assert.equal(m.icc, undefined);
    sizes[r.width] = r.webp.length;
  }
  // The phone's copy: the binding LCP budget (< 2 s at 4× CPU, Fast 3G) needs it small.
  assert.ok(sizes[640] <= 30_000, `640 is ${sizes[640]} bytes`);
  assert.ok(sizes[640] < sizes[1080] && sizes[1080] < sizes[1600]);
  assert.ok(sizes[1600] < sizes.full);
  console.log(`cover rendition bytes: ${JSON.stringify(sizes)}`);
});

test('never upscaled: widths at or above the source are skipped', async () => {
  const at = async (width) =>
    (
      await coverRenditionsOf(
        await reencodeTo(
          width,
          Math.round((width * 600) / 2240),
        )(await photoLike({ width: 1200, height: 800, shapes: 800 })),
      )
    )
      .filter((r) => r.shape === 'wide')
      .map((r) => r.width);
  assert.deepEqual(await at(1600), [640, 1080]);
  assert.deepEqual(await at(1200), [640, 1080]);
  assert.deepEqual(await at(1080), [640]);
  assert.deepEqual(await at(641), [640]);
  assert.deepEqual(await at(640), []);
  assert.deepEqual(await at(320), []);
});

test('not an image: refused, as an upload would be', async () => {
  await assert.rejects(coverRenditionsOf(Buffer.from('not an image')));
});

// Tall crops (Stage and Horizon on phones): the hero is about 390×488 CSS px, object-fit: cover,
// object-position: 50% 33%. The 4:5 region it shows, cut on the server, so a phone fetches that
// region and not the whole 2240-wide band.

test('tall crop geometry: a 2240×600 cover gives a 480×600 region at x=880, y=0', () => {
  assert.deepEqual(tallCropRegion(2240, 600), {
    left: 880,
    top: 0,
    width: 480,
    height: 600,
  });
  // Wider than 4:5: the full height, centred across (50%), so the vertical position plays no part.
  assert.deepEqual(tallCropRegion(2240, 1000), {
    left: 720,
    top: 0,
    width: 800,
    height: 1000,
  });
  // Taller than 4:5: the full width, and 33% of the spare height above (object-position's rule:
  // offset = (source − region) × 33%), 250 × 0.33 = 82.5, rounded.
  assert.deepEqual(tallCropRegion(1000, 1500), {
    left: 0,
    top: 83,
    width: 1000,
    height: 1250,
  });
  // Exactly 4:5: the whole image.
  assert.deepEqual(tallCropRegion(800, 1000), {
    left: 0,
    top: 0,
    width: 800,
    height: 1000,
  });
});

test('tall crop widths come from the crop: never upscaled, a width wider than the crop skipped', () => {
  assert.deepEqual([...COVER_TALL_WIDTHS], [480, 720]);
  assert.deepEqual(tallCropWidths(480), [480]);
  assert.deepEqual(tallCropWidths(719), [480]);
  assert.deepEqual(tallCropWidths(720), [480, 720]);
  assert.deepEqual(tallCropWidths(1000), [480, 720]);
  assert.deepEqual(tallCropWidths(479), []);
  assert.deepEqual(tallCropWidths(0), []);
});

test('a stored cover gets a 480×600 tall crop showing exactly the hero region, small for a phone', async () => {
  const full = await toCover(await photoLike());
  const all = await coverRenditionsOf(full);
  const tall = all.filter((r) => r.shape === 'tall');
  // 600 high: the crop is 480 wide, so 720 would be an upscale and is skipped.
  assert.deepEqual(
    tall.map((r) => r.width),
    [480],
  );
  const [crop] = tall;
  const meta = await sharp(crop.webp).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 480, 600]);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
  // The same pixels the CSS shows today: compare with the region cut from the stored cover.
  const expected = await sharp(full)
    .extract({ left: 880, top: 0, width: 480, height: 600 })
    .removeAlpha()
    .raw()
    .toBuffer();
  const got = await sharp(crop.webp).removeAlpha().raw().toBuffer();
  assert.equal(got.length, expected.length);
  let diff = 0;
  for (let i = 0; i < got.length; i += 1)
    diff += Math.abs(got[i] - expected[i]);
  const mean = diff / got.length;
  assert.ok(mean < 6, `mean difference ${mean.toFixed(2)} per channel`);
  const sizes = { full: full.length };
  for (const r of all) sizes[`${r.shape}-${r.width}`] = r.webp.length;
  // Smaller than the full band by far: that is the whole point (lab LCP 3.3 s on the full file).
  assert.ok(crop.webp.length < full.length / 3, JSON.stringify(sizes));
  console.log(`cover tall crop bytes: ${JSON.stringify(sizes)}`);
});

test('a taller source gets both tall widths, at 4:5, from its 33% band', async () => {
  const source = await sharp(
    await photoLike({ width: 1000, height: 1500, shapes: 1500 }),
  )
    .webp({ quality: 80 })
    .toBuffer();
  const tall = (await coverRenditionsOf(source)).filter(
    (r) => r.shape === 'tall',
  );
  assert.deepEqual(
    await Promise.all(
      tall.map(async (r) => {
        const m = await sharp(r.webp).metadata();
        return [r.width, m.width, m.height];
      }),
    ),
    [
      [480, 480, 600],
      [720, 720, 900],
    ],
  );
});

test('a tall crop address names its shape; anything else is not one', () => {
  const id = '0d7f6d2c-6a51-4c0a-9d3e-6b9f3c2a1e00';
  assert.deepEqual(renditionFile(id, '3-tall-480.webp'), {
    version: 3,
    shape: 'tall',
    width: 480,
  });
  assert.deepEqual(renditionFile(id, '3-640.webp'), {
    version: 3,
    shape: 'wide',
    width: 640,
  });
  for (const file of [
    '3-tall-640.webp',
    '3-480.webp',
    '3-tall-0480.webp',
    '3-TALL-480.webp',
    '3-tall480.webp',
    '3-wide-640.webp',
  ])
    assert.equal(renditionFile(id, file), null, file);
});
