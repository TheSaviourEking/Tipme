import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { COVER_RENDITION_WIDTHS } from '@tipme/contracts';
import { reencodeTo } from '../dist/profiles/image-upload.js';
import {
  coverRenditionsOf,
  toCover,
} from '../dist/profiles/cover-renditions.js';
import { photoLike } from './photo-like.mjs';

// Cover renditions (Studio styles spec §9.4/§9.9): the stored 2240×600 cover at 640, 1080 and
// 1600 wide, same shape, WebP, no metadata, never upscaled. Measured on a generated photo only.

test('a cover gets every rendition width, same shape, small enough for a phone', async () => {
  const full = await toCover(await photoLike());
  const meta = await sharp(full).metadata();
  assert.deepEqual([meta.width, meta.height], [2240, 600]);
  const renditions = await coverRenditionsOf(full);
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
    ).map((r) => r.width);
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
