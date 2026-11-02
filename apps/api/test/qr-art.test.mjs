import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import { PRO_QR_STYLES } from '@tipme/contracts';
import sharp from 'sharp';
import {
  QR_ART,
  MOSAIC_FACE_ALIGNMENT_MODULES,
  QrArtPhotoRequiredError,
  QrArtPhotoTooLargeError,
  qrArtLayout,
  qrMosaicFit,
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
async function photographed(png, blurDivisor = 400) {
  const { width } = await sharp(png).metadata();
  const jpeg = await sharp(png)
    .flatten({ background: '#ffffff' })
    .blur(width / blurDivisor)
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
        previewOrigin: ORIGIN,
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
  const png = await renderQrArt({
    ...base,
    preview: true,
    previewOrigin: ORIGIN,
  });
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
async function sampleModules(art, url, photo = photoFor(art), size = 1000) {
  const png = await renderQrArt({
    id: art.id,
    url,
    photo,
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
  const cases = QR_ART.flatMap((art) =>
    art.kind === 'photo'
      ? Object.entries(PHOTOS).map(([name, photo]) => [art, photo, name])
      : [[art, undefined, '']],
  );
  for (const [art, photo, photoName] of cases)
    for (const handle of HANDLES) {
      const { dark, light } = await sampleModules(
        art,
        `${ORIGIN}/@${handle}?src=qr`,
        photo,
      );
      const lightest = Math.max(...dark.map((m) => m.l));
      const darkest = Math.min(...light.map((m) => m.l));
      const ratio = (darkest + 0.05) / (lightest + 0.05);
      assert.ok(
        ratio >= 4.5,
        `${art.id} ${photoName}/${handle}: ${ratio.toFixed(2)}:1`,
      );
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

/** Every design, every mosaic photo, both handles and sizes, through one blur strength. */
async function fragileAt(blurDivisor) {
  const fragile = [];
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
          if ((await read(await photographed(png, blurDivisor))) !== url)
            fragile.push(
              `${art.id}${photoName && `:${photoName}`}/${handle.length}/${size}`,
            );
        }
  return fragile.sort();
}

// Fragile designs still ship: these pin the lists so a change for better or worse is noticed.
test('every design survives a mild phone-photo blur and a JPEG round trip', async () => {
  // Sigma is width/400: 2.5 at 1000 pixels, 0.75 at 300. JPEG quality 70.
  assert.deepEqual(await fragileAt(400), []);
});

test('at a slightly harder blur only the mosaic fails, and it is known to be fragile', async () => {
  // Sigma is width/333: 3 at 1000 pixels, 0.9 at 300. JPEG quality 70. A real portrait also passed
  // only 2 of 4 runs here (measured by hand; a person's photo isn't kept in the repo).
  const KNOWN_FRAGILE = [
    'mosaic:busy/3/1000',
    'mosaic:busy/31/1000',
    'mosaic:dark/3/1000',
    'mosaic:dark/31/1000',
    'mosaic:light/3/1000',
    'mosaic:light/31/1000',
  ];
  assert.deepEqual(await fragileAt(333), KNOWN_FRAGILE);
});

const longHome = (n) => `${ORIGIN}/@${'a'.repeat(n)}?src=qr`;

test('a preview leads to the given web origin, whatever link it is handed', async () => {
  const home = `${ORIGIN}/?src=qr-preview`;
  const base = { id: 'heart', preview: true, size: 300 };
  const png = await renderQrArt({
    ...base,
    url: 'https://evil.example/@x',
    previewOrigin: ORIGIN,
  });
  assert.equal(await read(png), home);
  // No link at all is fine: a preview does not use one.
  assert.equal(
    await read(await renderQrArt({ ...base, previewOrigin: ORIGIN })),
    home,
  );
  await assert.rejects(
    renderQrArt({ ...base, url: 'https://evil.example/@x' }),
    RangeError,
  );
  for (const previewOrigin of [
    'http://www.usetipme.xyz',
    `${ORIGIN}/`,
    `${ORIGIN}/@dr7`,
    'not a link',
  ])
    await assert.rejects(
      renderQrArt({ ...base, previewOrigin }),
      RangeError,
      previewOrigin,
    );
});

test('links are checked before they reach the encoder', async () => {
  const base = { id: 'heart', preview: false, size: 300 };
  for (const url of [
    'http://www.usetipme.xyz/@dr7',
    'https://www.usetipme.xyz', // the browser's form has the slash
    'HTTPS://www.usetipme.xyz/@dr7',
    `${ORIGIN}/@d\nr7`,
    `${ORIGIN}/@d\tr7`,
    `${ORIGIN}/@dr7\u0000`,
    `${ORIGIN}/@dr7 `,
    `${ORIGIN}/@dr\u20a67`,
    'https://me:secret@www.usetipme.xyz/@dr7',
    `${ORIGIN}/@${'a'.repeat(300)}`,
    `${ORIGIN}/@${'a\u20a6'.repeat(100_000)}`,
    'javascript:alert(1)',
    '',
  ])
    await assert.rejects(
      renderQrArt({ ...base, url }),
      RangeError,
      url.slice(0, 40),
    );
  await assert.rejects(renderQrArt(base), RangeError);
});

test('plain http is allowed only when asked for, and only on this machine', async () => {
  const base = { id: 'heart', preview: false, size: 300, allowLocalHttp: true };
  const url = 'http://127.0.0.1:3000/@dr7?src=qr';
  assert.equal(await read(await renderQrArt({ ...base, url })), url);
  assert.equal(
    await read(
      await renderQrArt({ ...base, url: 'http://localhost:3000/@dr7' }),
    ),
    'http://localhost:3000/@dr7',
  );
  await assert.rejects(
    renderQrArt({ ...base, url: 'http://www.usetipme.xyz/@dr7' }),
    RangeError,
  );
  await assert.rejects(
    renderQrArt({ ...base, allowLocalHttp: false, url }),
    RangeError,
  );
  assert.equal(
    await read(
      await renderQrArt({
        ...base,
        preview: true,
        previewOrigin: 'http://127.0.0.1:3000',
      }),
    ),
    'http://127.0.0.1:3000/?src=qr-preview',
  );
});

test('an oversized photo has its own error, not the one for no photo', async () => {
  const photo = await sharp({
    create: { width: 6000, height: 5000, channels: 3, background: '#888' },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  await assert.rejects(
    renderQrArt({
      id: 'mosaic',
      url: `${ORIGIN}/@dr7`,
      photo,
      preview: false,
      size: 300,
    }),
    QrArtPhotoTooLargeError,
  );
  assert.equal(
    new QrArtPhotoTooLargeError() instanceof QrArtPhotoRequiredError,
    false,
  );
});

test('the largest size is the card frame, 1400 pixels', async () => {
  const base = { id: 'indigo', url: `${ORIGIN}/@dr7`, preview: false };
  const png = await renderQrArt({ ...base, size: 1400 });
  assert.equal((await sharp(png).metadata()).width, 1400);
  await assert.rejects(renderQrArt({ ...base, size: 1401 }), RangeError);
});

test('it says when extra alignment patterns would land on a mosaic face, and refuses nothing', async () => {
  assert.equal(MOSAIC_FACE_ALIGNMENT_MODULES, 45);
  assert.deepEqual(qrMosaicFit(`${ORIGIN}/@dr7?src=qr`), {
    version: 5,
    modules: 37,
    alignmentOnFace: false,
  });
  // A 25-character handle is the last clear one on the live link.
  assert.equal(qrMosaicFit(longHome(25)).alignmentOnFace, false);
  assert.deepEqual(qrMosaicFit(longHome(26)), {
    version: 7,
    modules: 45,
    alignmentOnFace: true,
  });
  assert.throws(() => qrMosaicFit('http://www.usetipme.xyz/@dr7'), RangeError);
  // Advice only: the long link still renders (and scans in software), but the page promises nothing.
  const url = longHome(30);
  const png = await renderQrArt({
    id: 'mosaic',
    url,
    photo: PHOTOS.busy,
    preview: false,
    size: 300,
  });
  assert.equal(await read(png), url);
});

test('the ids a page may save are exactly the drawn designs', () => {
  assert.deepEqual([...PRO_QR_STYLES].sort(), QR_ART.map((a) => a.id).sort());
});

test('a public preview that fails to draw is never cached, and a good one is', async () => {
  const { QrArtPreviewController } =
    await import('../dist/qr/qr-art.controller.js');
  const answer = () => {
    const sent = { headers: {}, body: undefined };
    const response = {
      status: () => response,
      set: (headers) => {
        Object.assign(sent.headers, headers);
        return response;
      },
      send: (body) => {
        sent.body = body;
      },
    };
    return { sent, response };
  };
  // An origin the drawing refuses (plain http outside local runs), so the draw rejects.
  const broken = new QrArtPreviewController({
    WEB_ORIGIN: 'http://example.test',
    NODE_ENV: 'production',
  });
  const failed = answer();
  await assert.rejects(broken.preview('heart.png', failed.response));
  assert.equal(failed.sent.headers['Cache-Control'], undefined);
  assert.equal(failed.sent.body, undefined);
  const working = new QrArtPreviewController({
    WEB_ORIGIN: ORIGIN,
    NODE_ENV: 'production',
  });
  const good = answer();
  await working.preview('heart.png', good.response);
  assert.match(good.sent.headers['Cache-Control'], /public, max-age=86400/);
  assert.ok(Buffer.isBuffer(good.sent.body));
});
