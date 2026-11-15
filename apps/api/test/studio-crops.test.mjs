import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  cropBox,
  masterOf,
  renditionsOf,
} from '../dist/studio/studio-crops.js';

// Page Studio photos (plan Task 7): a master no larger than 2400px, then each shape cropped around
// the focal point at 480/960/1440 wide, never upscaled, metadata dropped. Generated images only.

/** A grey gradient with a red square marking (mx, my) as fractions of the image. */
async function photo(
  width,
  height,
  { mx = 0.5, my = 0.5, format = 'jpeg', metadata } = {},
) {
  const raw = Buffer.alloc(width * height * 3);
  const size = Math.max(8, Math.round(Math.min(width, height) * 0.04));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const red =
        Math.abs(x - mx * width) < size && Math.abs(y - my * height) < size;
      raw[i] = red ? 230 : Math.round((x / width) * 120 + 60);
      raw[i + 1] = red ? 20 : Math.round((y / height) * 120 + 60);
      raw[i + 2] = red ? 20 : 140;
    }
  let image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (metadata) image = image.withMetadata(metadata);
  return format === 'png'
    ? image.png().toBuffer()
    : image.jpeg({ quality: 90 }).toBuffer();
}

const hasRed = async (webp) => {
  const { data, info } = await sharp(webp)
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80) return true;
  return false;
};

test('refuses a photo under 600px on its short side, after the camera rotation, with IMAGE_TOO_SMALL', async () => {
  await assert.rejects(masterOf(await photo(1200, 599)), {
    code: 'IMAGE_TOO_SMALL',
  });
  // Stored sideways (500 wide) with an orientation that turns it upright: still 500 on one side.
  await assert.rejects(
    masterOf(await photo(900, 500, { metadata: { orientation: 6 } })),
    { code: 'IMAGE_TOO_SMALL' },
  );
  const ok = await masterOf(await photo(600, 1200));
  assert.deepEqual([ok.width, ok.height], [600, 1200]);
});

test('the master honours the camera rotation and fits inside 2400px', async () => {
  const turned = await masterOf(
    await photo(1000, 700, { metadata: { orientation: 6 } }),
  );
  assert.deepEqual([turned.width, turned.height], [700, 1000]);
  const big = await masterOf(await photo(4000, 3000));
  assert.deepEqual([big.width, big.height], [2400, 1800]);
  assert.equal((await sharp(big.master).metadata()).format, 'webp');
});

test('refuses what is not a decodable JPEG, PNG or WebP', async () => {
  await assert.rejects(
    masterOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    { code: 'INVALID_IMAGE' },
  );
  await assert.rejects(masterOf(Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2])), {
    code: 'INVALID_IMAGE',
  });
});

test('never upscales a rendition and keeps the focal point in every shape', async () => {
  const { master } = await masterOf(
    await photo(1600, 700, { mx: 0.85, my: 0.2 }),
  );
  const files = await renditionsOf(master, 85, 20);
  // square: crop 700 wide → 480 only; wide: 1244 → 480, 960; tall: 560 → 480; strip: 1600 → all three.
  assert.deepEqual(Object.keys(files).sort(), [
    'square-480',
    'strip-1440',
    'strip-480',
    'strip-960',
    'tall-480',
    'wide-480',
    'wide-960',
  ]);
  for (const [name, webp] of Object.entries(files)) {
    const meta = await sharp(webp).metadata();
    assert.equal(meta.width, Number(name.split('-')[1]), name);
    assert.ok(await hasRed(webp), `${name} lost the focal point`);
  }
  // Centred instead, the square crop of this wide photo misses the marker at 85% across.
  assert.equal(
    await hasRed((await renditionsOf(master, 50, 50))['square-480']),
    false,
  );
});

test('a crop is the largest rectangle of its shape around the focal point, inside the photo', () => {
  assert.deepEqual(cropBox(1600, 700, 1, 85, 20), {
    left: 900,
    top: 0,
    width: 700,
    height: 700,
  });
  assert.deepEqual(cropBox(1600, 700, 1, 0, 50), {
    left: 0,
    top: 0,
    width: 700,
    height: 700,
  });
  assert.deepEqual(cropBox(1000, 2000, 16 / 9, 50, 100), {
    left: 0,
    top: 1438,
    width: 1000,
    height: 562,
  });
  for (const [w, h, a] of [
    [601, 1999, 3.73],
    [2400, 600, 4 / 5],
    [777, 777, 16 / 9],
  ])
    for (const f of [0, 37, 100]) {
      const box = cropBox(w, h, a, f, f);
      assert.ok(
        box.left >= 0 &&
          box.top >= 0 &&
          box.left + box.width <= w &&
          box.top + box.height <= h,
      );
      assert.ok(Math.abs(box.width / box.height - a) < 0.02, `${w}x${h} ${a}`);
    }
});

test('strips metadata from the master and every rendition', async () => {
  const input = await photo(1200, 900, {
    metadata: {
      exif: { IFD0: { Copyright: 'Someone', Artist: 'Camera owner' } },
    },
  });
  assert.ok(
    (await sharp(input).metadata()).exif,
    'the test photo carries EXIF',
  );
  const { master } = await masterOf(input);
  for (const webp of [
    master,
    ...Object.values(await renditionsOf(master, 50, 50)),
  ]) {
    const meta = await sharp(webp).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.xmp, undefined);
  }
});
