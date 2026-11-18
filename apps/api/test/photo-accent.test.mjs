import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { hexToOklch } from '@tipme/contracts';
import { reencodeTo } from '../dist/profiles/image-upload.js';
import {
  photoAccentFor,
  sampleAvatarColours,
} from '../dist/studio/photo-accent.js';
import { photoLike } from './photo-like.mjs';

// "From your photo" (styles spec §6): colours sampled from the stored 512 px avatar. Generated
// images only; never a real person's photo (the repository is public).

const toAvatar = reencodeTo(512, 512);

/** A generated avatar: a background, a large "shirt" block and a small square. */
const avatar = async (background, block, square = '#f5c400') =>
  toAvatar(
    await sharp({
      create: { width: 600, height: 600, channels: 3, background },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="600" height="600"><rect x="0" y="380" width="600" height="220" fill="${block}"/><rect x="40" y="40" width="80" height="80" fill="${square}"/></svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer(),
  );

test('sampling is deterministic for the same image', async () => {
  const webp = await toAvatar(await photoLike({ width: 800, height: 800 }));
  const first = await sampleAvatarColours(webp);
  const again = await sampleAvatarColours(Buffer.from(webp));
  assert.deepEqual(again, first);
  assert.ok(first.length >= 1 && first.length <= 5, JSON.stringify(first));
  for (const c of first) assert.match(c, /^#[0-9a-f]{6}$/);
  // The whole path, twice: the same accent.
  assert.deepEqual(await photoAccentFor(webp), await photoAccentFor(webp));
});

test('the most dominant colour comes first, and distinct colours are kept apart', async () => {
  const colours = await sampleAvatarColours(
    await avatar({ r: 40, g: 110, b: 210 }, '#d81b60'),
  );
  const hue = (c) => hexToOklch(c).h;
  const near = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) < 12;
  assert.ok(near(hue(colours[0]), hue('#286ed2')), JSON.stringify(colours));
  assert.ok(
    colours.slice(1).some((c) => near(hue(c), hue('#d81b60'))),
    JSON.stringify(colours),
  );
  // A one-colour image is one colour, not five copies of it.
  const flat = await sampleAvatarColours(
    await toAvatar(
      await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 3,
          background: { r: 11, g: 122, b: 75 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  assert.equal(flat.length, 1, JSON.stringify(flat));
});

test('a colourful avatar gives a photo accent; a grey one falls back', async () => {
  const colourful = await photoAccentFor(
    await avatar({ r: 40, g: 110, b: 210 }, '#d81b60'),
  );
  assert.ok(colourful && !('failed' in colourful), JSON.stringify(colourful));
  const grey = await photoAccentFor(
    await avatar({ r: 128, g: 128, b: 128 }, '#5a5a5a', '#d0d0d0'),
  );
  assert.deepEqual(grey, { failed: true, fallback: 'ink' });
});

test('sampling that fails never throws: no accent, and the page id alone is logged', async () => {
  const logged = [];
  const log = { warn: (entry) => logged.push(entry) };
  assert.equal(
    await photoAccentFor(Buffer.from('not an image'), {
      log,
      profileId: 'page-1',
    }),
    null,
  );
  assert.equal(
    await photoAccentFor(Buffer.alloc(10), {
      log,
      profileId: 'page-1',
      sample: async () => {
        throw new Error('libvips said no, with a path /tmp/x');
      },
    }),
    null,
  );
  assert.deepEqual(logged, [
    { event: 'studio.photo_accent_failed', profileId: 'page-1' },
    { event: 'studio.photo_accent_failed', profileId: 'page-1' },
  ]);
});

test('sampling is bounded: a huge input is refused, not decoded', async () => {
  // 6000×6000 is far over what a stored avatar (512×512) can be.
  const huge = await sharp({
    create: {
      width: 6000,
      height: 6000,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .webp({ quality: 10 })
    .toBuffer();
  await assert.rejects(sampleAvatarColours(huge));
});

test('a light face and a deep face on grey give the same fallback', async () => {
  // Monk scale 4 and 8 as flat generated faces on a grey background: no person.
  const face = async (skin) =>
    photoAccentFor(
      await toAvatar(
        await sharp({
          create: {
            width: 600,
            height: 600,
            channels: 3,
            background: { r: 128, g: 128, b: 128 },
          },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg width="600" height="600"><ellipse cx="300" cy="300" rx="190" ry="240" fill="${skin}"/></svg>`,
              ),
              top: 0,
              left: 0,
            },
          ])
          .png()
          .toBuffer(),
      ),
    );
  const light = await face('#eadaba');
  const deep = await face('#604134');
  assert.deepEqual(light, deep);
  assert.deepEqual(light, { failed: true, fallback: 'ink' });
});

test('a photo with no clear colour says so, not that contrast failed', async () => {
  // A smooth two-way gradient: no colour box holds 1% of the pixels.
  const n = 512;
  const raw = Buffer.alloc(n * n * 3);
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      const i = (y * n + x) * 3;
      raw[i] = x / 2;
      raw[i + 1] = y / 2;
      raw[i + 2] = 128;
    }
  const gradient = await sharp(raw, {
    raw: { width: n, height: n, channels: 3 },
  })
    .webp()
    .toBuffer();
  assert.deepEqual(await sampleAvatarColours(gradient), []);
  assert.deepEqual(await photoAccentFor(gradient), {
    failed: true,
    fallback: 'ink',
    nothingSampled: true,
  });
});
