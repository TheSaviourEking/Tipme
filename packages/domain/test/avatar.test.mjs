import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AVATAR_MAX_BYTES, inspectAvatar } from '../dist/index.js';

const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const chunk = (fourcc, data) => [
  ...ascii(fourcc),
  ...u32(data.length),
  ...data,
  ...(data.length % 2 ? [0] : []),
];
const riff = (...chunks) => {
  const body = [...ascii('WEBP'), ...chunks.flat()];
  return Uint8Array.from([...ascii('RIFF'), ...u32(body.length), ...body]);
};
// A lossy frame header: keyframe tag, start code 9d 01 2a, then 14-bit width and height.
const vp8 = (w, h) =>
  chunk('VP8 ', [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    w & 255,
    w >> 8,
    h & 255,
    h >> 8,
    0,
    0,
  ]);
const vp8x = (flags, w, h) =>
  chunk('VP8X', [
    flags,
    0,
    0,
    0,
    (w - 1) & 255,
    ((w - 1) >> 8) & 255,
    ((w - 1) >> 16) & 255,
    (h - 1) & 255,
    ((h - 1) >> 8) & 255,
    ((h - 1) >> 16) & 255,
  ]);

const size = (bytes) => {
  const result = inspectAvatar(bytes);
  return result && { width: result.width, height: result.height };
};

test('a plain WebP photo is accepted with its size and stored unchanged', () => {
  const plain = riff(vp8(960, 1200));
  assert.deepEqual(size(plain), { width: 960, height: 1200 });
  assert.deepEqual(inspectAvatar(plain).bytes, plain);
  assert.deepEqual(
    size(riff(vp8x(0x10, 800, 1000), chunk('ALPH', [0, 1]), vp8(800, 1000))),
    { width: 800, height: 1000 },
  );
});

test('a browser’s colour profile is removed rather than refused', () => {
  // Chrome's canvas encoder always writes an sRGB ICCP chunk and sets the ICC flag.
  const result = inspectAvatar(
    riff(vp8x(0x20, 960, 1200), chunk('ICCP', [7, 7, 7]), vp8(960, 1200)),
  );
  assert.deepEqual(
    { width: result.width, height: result.height },
    { width: 960, height: 1200 },
  );
  assert.deepEqual(result.bytes, riff(vp8x(0, 960, 1200), vp8(960, 1200)));
  // The cleaned file passes the check again, unchanged.
  assert.deepEqual(inspectAvatar(result.bytes).bytes, result.bytes);
});

test('metadata, animation, other formats and oversized images are refused', () => {
  // EXIF or XMP (where GPS lives), declared or present, and animation chunks.
  assert.equal(inspectAvatar(riff(vp8x(0x08, 800, 800), vp8(800, 800))), null);
  assert.equal(inspectAvatar(riff(vp8x(0x02, 800, 800), vp8(800, 800))), null);
  assert.equal(inspectAvatar(riff(vp8x(0x04, 800, 800), vp8(800, 800))), null);
  assert.equal(
    inspectAvatar(riff(vp8(800, 800), chunk('EXIF', [1, 2, 3, 4]))),
    null,
  );
  assert.equal(inspectAvatar(riff(vp8(800, 800), chunk('XMP ', [1, 2]))), null);
  assert.equal(inspectAvatar(riff(vp8(800, 800), chunk('ANIM', [0, 0]))), null);
  // Not WebP at all (a JPEG), a truncated file, a lying length, too big in pixels or bytes.
  assert.equal(
    inspectAvatar(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ),
    null,
  );
  const good = riff(vp8(960, 1200));
  assert.equal(inspectAvatar(good.slice(0, good.length - 3)), null);
  assert.equal(inspectAvatar(riff(vp8(4000, 1200))), null);
  const huge = new Uint8Array(AVATAR_MAX_BYTES + 1);
  huge.set(good);
  assert.equal(inspectAvatar(huge), null);
});
