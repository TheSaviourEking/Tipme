import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { splitInkAccent } from './design/brand-assets.mjs';

const sharp = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
)('sharp');
const pub = (path) =>
  fileURLToPath(new URL(`../apps/web/public/${path}`, import.meta.url));
const raw = async (input) =>
  sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test('the logo splits into its black (ink) and its purple (accent)', () => {
  const px = (...rgba) => Buffer.from(rgba);
  const alphas = (data) => {
    const { ink, accent } = splitInkAccent(data);
    return [ink[3], accent[3]];
  };
  assert.deepEqual(alphas(px(0, 0, 0, 255)), [255, 0]);
  assert.deepEqual(alphas(px(0x7a, 0x32, 0xf9, 255)), [0, 255]);
  assert.deepEqual(alphas(px(0x7a, 0x32, 0xf9, 0)), [0, 0]);
  assert.deepEqual(alphas(px(0, 0, 0, 128)), [128, 0]);
  // An edge pixel between the two, half and half: accent 50%, ink under it fills the rest.
  assert.deepEqual(alphas(px(61, 25, 125, 255)), [255, 128]);
});

/** Ink drawn in `inkColour`, accent over it in purple, on a transparent ground (premultiplied). */
async function recompose(name, inkColour) {
  const ink = await raw(pub(`brand/${name}-ink.png`));
  const accent = await raw(pub(`brand/${name}-accent.png`));
  const { width, height } = ink.info;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const ai = ink.data[i * 4 + 3] / 255;
    const aa = accent.data[i * 4 + 3] / 255;
    const a = aa + ai * (1 - aa);
    for (let c = 0; c < 3; c += 1)
      out[i * 4 + c] = Math.round(
        (aa * [0x7a, 0x32, 0xf9][c] + ai * (1 - aa) * inkColour[c]) *
          (a ? 1 / a : 0),
      );
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return { data: out, width, height };
}

async function assertSamePicture(name, source, inkColour) {
  const drawn = await recompose(name, inkColour);
  const { data } = await sharp(pub(`brand/${source}`))
    // Reduced as the script reduces it (by height), so the two grids match.
    .resize({ height: drawn.height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let worst = 0;
  let where = -1;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const diffs = [Math.abs(a - drawn.data[i + 3])];
    // Colour only where the pixel is mostly there (a faint edge pixel's colour barely shows).
    if (a > 64)
      for (let c = 0; c < 3; c += 1)
        diffs.push(Math.abs(data[i + c] - drawn.data[i + c]));
    const d = Math.max(...diffs);
    if (d > worst) [worst, where] = [d, i / 4];
  }
  // Up to 24: reducing the owner's file rings a little past its colours at hard edges (e.g.
  // 140,57,255 inside the purple); the split clamps that back to the brand's own two colours.
  assert.ok(
    worst <= 24,
    `${name} vs ${source}: worst channel difference ${worst} at pixel ${where}`,
  );
}

test('the masks draw the owner’s light logo back in black and purple', async () => {
  await assertSamePicture(
    'tipme-wordmark',
    'tipme-wordmark-light.png',
    [0, 0, 0],
  );
  await assertSamePicture('tipme-mark', 'tipme-mark.png', [0, 0, 0]);
});

test('with a white ink the same masks draw the owner’s dark logo', async () => {
  await assertSamePicture(
    'tipme-wordmark',
    'tipme-wordmark-dark.png',
    [255, 255, 255],
  );
});

test('each icon is the heart on a white tile, of its stated size', async () => {
  for (const [file, side, rounded] of [
    ['favicon-32.png', 32, true],
    ['favicon-48.png', 48, true],
    ['192.png', 192, true],
    ['apple-touch-icon.png', 180, false],
    ['512-maskable.png', 512, false],
  ]) {
    const { data, info } = await raw(pub(`icons/${file}`));
    assert.deepEqual([info.width, info.height], [side, side], file);
    const at = (x, y) => [
      ...data.subarray((y * side + x) * 4, (y * side + x) * 4 + 4),
    ];
    // The corner: transparent when rounded, the white tile when full bleed.
    if (rounded) assert.equal(at(0, 0)[3], 0, file);
    else assert.deepEqual(at(0, 0), [255, 255, 255, 255], file);
    // The edge's middle is the tile; somewhere inside are the black and the purple figures.
    assert.deepEqual(at(Math.floor(side / 2), 1), [255, 255, 255, 255], file);
    let black = false;
    let purple = false;
    for (let i = 0; i < side * side; i += 1) {
      const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
      black ||= r < 40 && g < 40 && b < 40;
      purple ||= Math.abs(r - 0x7a) < 24 && Math.abs(g - 0x32) < 24 && b > 220;
    }
    assert.ok(black && purple, `${file}: both figures`);
  }
});

test('the email logos keep the artwork’s proportions at 2x and 3x', async () => {
  for (const scheme of ['light', 'dark'])
    for (const [scale, width, height] of [
      ['2x', 320, 88],
      ['3x', 480, 132],
    ]) {
      const meta = await sharp(
        pub(`email/tipme-logo-${scheme}-${scale}.png`),
      ).metadata();
      assert.deepEqual(
        [meta.width, meta.height],
        [width, height],
        `${scheme} ${scale}`,
      );
      assert.equal(meta.hasAlpha, true);
    }
});
