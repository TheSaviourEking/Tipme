import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import sharp from 'sharp';
import {
  QR_ART,
  QrArtPhotoRequiredError,
  qrArtLayout,
  renderQrArt,
} from '../dist/qr/render.js';

const ORIGIN = 'https://www.usetipme.xyz';
// The brief's long handle is 31 characters, one past the handle rule's 30: it is the harder case.
const HANDLES = ['dr7', 'a_thirty_character_handle_abcde'];
const urls = (handle) => [
  `${ORIGIN}/@${handle}`,
  `${ORIGIN}/@${handle}?src=qr`, // what a live page encodes
];
const SIZES = [1000, 300];

async function pixels(png) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
async function read(png) {
  const { data, width, height } = await pixels(png);
  return jsQR(new Uint8ClampedArray(data), width, height)?.data ?? null;
}
/** A phone photo of a screen or print, kept mild: a little out of focus, then saved as a JPEG. */
async function photographed(png) {
  const { width } = await sharp(png).metadata();
  const jpeg = await sharp(png)
    .flatten({ background: '#ffffff' })
    .blur(width / 400)
    .jpeg({ quality: 70 })
    .toBuffer();
  return sharp(jpeg).png().toBuffer();
}

// Real low-resolution input: what the page stores is a 512 x 512 WebP at quality 80.
const stored = (svg) =>
  sharp(Buffer.from(svg)).resize(512, 512).webp({ quality: 80 }).toBuffer();
const face = (ground, skin, hair) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${ground}"/><ellipse cx="256" cy="230" rx="110" ry="135" fill="${skin}"/><path d="M130 220C130 60 382 60 382 220C330 150 180 150 130 220Z" fill="${hair}"/><path d="M60 512C80 380 432 380 452 512Z" fill="${hair}"/></svg>`;
function busySvg() {
  let seed = 7;
  const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let body = '';
  for (let i = 0; i < 900; i++)
    body += `<rect x="${r() * 512}" y="${r() * 512}" width="${4 + r() * 50}" height="${4 + r() * 50}" fill="rgb(${r() * 255},${r() * 255},${r() * 255})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#777"/>${body}</svg>`;
}
const PHOTOS = {
  dark: await stored(face('#050505', '#2a1a12', '#000000')),
  light: await stored(face('#fbfbf6', '#f4e6d8', '#e8dfd0')),
  busy: await stored(busySvg()),
};
const photoFor = (art) => (art.kind === 'photo' ? PHOTOS.busy : undefined);

for (const art of QR_ART)
  for (const handle of HANDLES)
    for (const url of urls(handle))
      test(`${art.id} scans at 1000 and 300 pixels for ${url}`, async () => {
        for (const size of SIZES) {
          const png = await renderQrArt({
            id: art.id,
            url,
            photo: photoFor(art),
            preview: false,
            size,
          });
          const meta = await sharp(png).metadata();
          assert.equal(meta.format, 'png');
          assert.equal(meta.width, size);
          assert.equal(meta.height, size);
          assert.equal(await read(png), url, `at ${size}`);
        }
      });

test('the catalogue has unique ids a saved qrStyle can hold, and all three kinds', () => {
  assert.equal(new Set(QR_ART.map((a) => a.id)).size, QR_ART.length);
  for (const art of QR_ART) {
    assert.match(art.id, /^[a-z]{3,12}$/);
    assert.ok(art.name.length > 0);
  }
  assert.deepEqual([...new Set(QR_ART.map((a) => a.kind))].sort(), [
    'card',
    'photo',
    'style',
  ]);
});

test('a preview is marked and never encodes the given url when told not to', async () => {
  const page = `${ORIGIN}/@dr7?src=qr`;
  const home = `${ORIGIN}/?src=qr-preview`;
  for (const art of QR_ART)
    for (const size of SIZES) {
      const real = await renderQrArt({
        id: art.id,
        url: home,
        photo: photoFor(art),
        preview: false,
        size,
      });
      const marked = await renderQrArt({
        id: art.id,
        url: page,
        photo: photoFor(art),
        preview: true,
        size,
      });
      assert.equal(await read(marked), home, `${art.id} at ${size}`);
      // The same code either way, so any difference is the mark.
      const [a, b] = await Promise.all([pixels(real), pixels(marked)]);
      let changed = 0;
      let [minX, maxX, sumX, sumY] = [size, 0, 0, 0];
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          if (Math.abs(a.data[i + 1] - b.data[i + 1]) <= 20) continue;
          changed += 1;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          sumX += x;
          sumY += y;
        }
      const where = `${art.id} at ${size}`;
      assert.ok(changed > size * size * 0.02, `${where} carries the mark`);
      // Across the middle of the code, whole: a screenshot can't crop it away.
      assert.ok(
        minX > 0 && maxX < size - 1,
        `${where}: the mark is not clipped`,
      );
      assert.ok(maxX - minX > size * 0.6, `${where}: the mark is wide`);
      assert.ok(
        Math.abs(sumX / changed - size / 2) < size * 0.1,
        `${where}: centred across`,
      );
      assert.ok(
        Math.abs(sumY / changed - size / 2) < size * 0.1,
        `${where}: centred down`,
      );
    }
});

test('the preview mark still shows on a dark photo, and the preview still scans', async () => {
  const url = `${ORIGIN}/?src=qr-preview`;
  const base = { id: 'mosaic', url, photo: PHOTOS.dark, size: 1000 };
  const real = await pixels(await renderQrArt({ ...base, preview: false }));
  const png = await renderQrArt({ ...base, preview: true });
  const marked = await pixels(png);
  let changed = 0;
  for (let i = 0; i < real.data.length; i += 4)
    if (Math.abs(real.data[i + 1] - marked.data[i + 1]) > 20) changed += 1;
  assert.ok(changed > 1000 * 1000 * 0.04, `changed ${changed}`);
  assert.equal(await read(png), url);
});

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (d, i) =>
  0.2126 * channel(d[i]) +
  0.7152 * channel(d[i + 1]) +
  0.0722 * channel(d[i + 2]);

function finderCorner(n, a, b) {
  const local = (v) => (v < 7 ? v : v >= n - 7 ? v - (n - 7) : -1);
  const y = local(a);
  const x = local(b);
  if (y < 0 || x < 0 || (a >= n - 7 && b >= n - 7)) return false;
  // Sampled: the solid 3 x 3 eye and the ring's two axes, whatever shape the ring takes.
  const eye = x >= 2 && x <= 4 && y >= 2 && y <= 4;
  return !eye && x !== 3 && y !== 3;
}

/** The pixel at each module's centre, sorted into the code's dark and light modules. */
async function sampleModules(art, url, size = 1000) {
  const png = await renderQrArt({
    id: art.id,
    url,
    photo: photoFor(art),
    preview: false,
    size,
  });
  const { data, width } = await pixels(png);
  const layout = qrArtLayout({ id: art.id, url, preview: false });
  const dark = [];
  const light = [];
  for (let a = 0; a < layout.modules; a++)
    for (let b = 0; b < layout.modules; b++) {
      // A finder's ring may be drawn round, so its corners are not samples of the code.
      if (layout.covered(a, b) || finderCorner(layout.modules, a, b)) continue;
      const x = Math.floor((layout.left + (b + 0.5) * layout.module) * width);
      const y = Math.floor((layout.top + (a + 0.5) * layout.module) * width);
      const l = luminance(data, (y * width + x) * 4);
      (layout.dark(a, b) ? dark : light).push({ a, b, l });
    }
  return { dark, light, layout };
}

test('all module colours contrast at least 4.5:1 with the light behind them', async () => {
  for (const art of QR_ART)
    for (const handle of HANDLES) {
      const { dark, light } = await sampleModules(
        art,
        `${ORIGIN}/@${handle}?src=qr`,
      );
      const lightest = Math.max(...dark.map((m) => m.l));
      const darkest = Math.min(...light.map((m) => m.l));
      const ratio = (darkest + 0.05) / (lightest + 0.05);
      assert.ok(ratio >= 4.5, `${art.id}/${handle}: ${ratio.toFixed(2)}:1`);
    }
});

test('finder, separator, timing, format and alignment modules are exact in every design', async () => {
  for (const art of QR_ART)
    for (const handle of HANDLES) {
      const { dark, light, layout } = await sampleModules(
        art,
        `${ORIGIN}/@${handle}?src=qr`,
      );
      let checked = 0;
      for (let a = 0; a < layout.modules; a++)
        for (let b = 0; b < layout.modules; b++)
          if (layout.reserved(a, b)) {
            assert.equal(
              layout.covered(a, b),
              false,
              `${art.id} covers ${a},${b}`,
            );
            checked += 1;
          }
      assert.ok(checked > 100);
      const reservedDark = dark.filter((m) => layout.reserved(m.a, m.b));
      const reservedLight = light.filter((m) => layout.reserved(m.a, m.b));
      assert.ok(Math.max(...reservedDark.map((m) => m.l)) < 0.2, art.id);
      assert.ok(Math.min(...reservedLight.map((m) => m.l)) > 0.7, art.id);
    }
});

test('versions with many alignment patterns keep them all, and the version strips', () => {
  const layout = qrArtLayout({
    id: 'naira',
    url: `${ORIGIN}/@a_thirty_character_handle_abcde?src=qr`,
    preview: false,
  });
  assert.ok(layout.modules >= 45, 'the long link needs version 7 or more');
  // Version 7 has an alignment pattern dead centre: the naira mark must not sit on it.
  const c = Math.floor(layout.modules / 2);
  assert.equal(layout.reserved(c, c), true);
  assert.equal(layout.covered(c, c), false);
});

test('mosaic refuses without a photo, and scans with a dark, a light and a busy photo', async () => {
  await assert.rejects(
    renderQrArt({
      id: 'mosaic',
      url: `${ORIGIN}/@dr7`,
      preview: false,
      size: 300,
    }),
    QrArtPhotoRequiredError,
  );
  for (const [name, photo] of Object.entries(PHOTOS))
    for (const handle of HANDLES)
      for (const url of urls(handle))
        for (const size of SIZES) {
          const png = await renderQrArt({
            id: 'mosaic',
            url,
            photo,
            preview: false,
            size,
          });
          assert.equal(await read(png), url, `${name} at ${size} for ${url}`);
        }
});

test('mosaic refuses anything that is not a stored photo', async () => {
  await assert.rejects(
    renderQrArt({
      id: 'mosaic',
      url: `${ORIGIN}/@dr7`,
      photo: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      preview: false,
      size: 300,
    }),
    QrArtPhotoRequiredError,
  );
});

test('mosaic forces the centre of each module, leaves the photo around it, and keeps the quiet zone clean', async () => {
  const url = `${ORIGIN}/@dr7?src=qr`;
  const layout = qrArtLayout({ id: 'mosaic', url, preview: false });
  const size = Math.round(1 / layout.module) * 7 * 3;
  const png = await renderQrArt({
    id: 'mosaic',
    url,
    photo: PHOTOS.busy,
    preview: false,
    size,
  });
  const { data, width } = await pixels(png);
  const sub = (layout.module * width) / 7;
  const at = (a, b, u, w) => {
    const x = Math.floor(
      (layout.left + b * layout.module) * width + (w + 0.5) * sub,
    );
    const y = Math.floor(
      (layout.top + a * layout.module) * width + (u + 0.5) * sub,
    );
    return luminance(data, (y * width + x) * 4);
  };
  let photoShows = 0;
  for (let a = 0; a < layout.modules; a++)
    for (let b = 0; b < layout.modules; b++) {
      for (let u = 2; u <= 4; u++)
        for (let w = 2; w <= 4; w++) {
          const l = at(a, b, u, w);
          if (layout.dark(a, b)) assert.ok(l < 0.07, `dark ${a},${b}: ${l}`);
          else assert.ok(l > 0.6, `light ${a},${b}: ${l}`);
        }
      if (!layout.reserved(a, b)) {
        const corner = at(a, b, 0, 0);
        if (corner > 0.07 && corner < 0.6) photoShows += 1;
      }
    }
  assert.ok(photoShows > 100, 'the photo still shows around the centres');
  const margin = Math.floor(layout.left * width) - 1;
  for (let i = 0; i < width; i += 3) {
    assert.ok(luminance(data, (0 * width + i) * 4) > 0.99);
    assert.ok(luminance(data, ((margin - 1) * width + i) * 4) > 0.99);
    assert.ok(luminance(data, (i * width + margin - 1) * 4) > 0.99);
  }
});

test('a Pro render does not embed the photo metadata', async () => {
  const secret = 'SECRET-CAMERA-LOCATION';
  const photo = await sharp(PHOTOS.busy)
    .withExif({ IFD0: { Copyright: secret } })
    .webp({ quality: 80 })
    .toBuffer();
  assert.ok(photo.includes(secret), 'the input really carries metadata');
  const png = await renderQrArt({
    id: 'mosaic',
    url: `${ORIGIN}/@dr7`,
    photo,
    preview: false,
    size: 300,
  });
  assert.equal(png.includes(secret), false);
  const meta = await sharp(png).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.iptc, undefined);
  assert.equal(meta.icc, undefined);
});

test('rendering refuses unknown designs, silly sizes and links it should not encode', async () => {
  const base = {
    id: 'heart',
    url: `${ORIGIN}/@dr7`,
    preview: false,
    size: 300,
  };
  await assert.rejects(renderQrArt({ ...base, id: 'sunset' }), RangeError);
  await assert.rejects(renderQrArt({ ...base, size: 10 }), RangeError);
  await assert.rejects(renderQrArt({ ...base, size: 9000 }), RangeError);
  await assert.rejects(renderQrArt({ ...base, size: 300.5 }), RangeError);
  await assert.rejects(
    renderQrArt({ ...base, url: 'javascript:alert(1)' }),
    RangeError,
  );
});

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

test('cards use artwork bundled with the API, never the web app or a server font', async () => {
  for (const file of walk(join(apiRoot, 'src/qr'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /apps\/web|public\/covers|\.\.\/web\//, file);
    assert.doesNotMatch(source, /<text|font-family/, file);
  }
  const frames = readdirSync(join(apiRoot, 'assets/qr-cards'));
  assert.equal(
    frames.length,
    QR_ART.filter((a) => a.kind === 'card').length,
    frames.join(),
  );
  for (const frame of frames) {
    const meta = await sharp(
      join(apiRoot, 'assets/qr-cards', frame),
    ).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, meta.height);
  }
});

test('a clean design survives a mild phone-photo blur and a JPEG round trip, or is known to be fragile', async () => {
  // Fragile designs still ship: this pins the list so a change for better or worse is noticed.
  const KNOWN_FRAGILE = new Set([]);
  const fragile = new Set();
  for (const art of QR_ART)
    for (const [photoName, photo] of art.kind === 'photo'
      ? Object.entries(PHOTOS)
      : [['', undefined]])
      for (const handle of HANDLES)
        for (const size of SIZES) {
          const url = `${ORIGIN}/@${handle}?src=qr`;
          const png = await renderQrArt({
            id: art.id,
            url,
            photo,
            preview: false,
            size,
          });
          if ((await read(await photographed(png))) !== url)
            fragile.add(
              `${art.id}${photoName && `:${photoName}`}/${handle.length}/${size}`,
            );
        }
  assert.deepEqual([...fragile].sort(), [...KNOWN_FRAGILE].sort());
});
