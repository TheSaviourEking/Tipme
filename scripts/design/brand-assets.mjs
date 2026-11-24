// Everything drawn from the owner's final logo files (PNG, 24 Nov 2026) in apps/web/public/brand:
//   tipme-wordmark-light.png  the heart of two figures + "tipme" + ™, black and purple (light grounds)
//   tipme-wordmark-dark.png   the same with white for black (dark grounds)
//   tipme-mark.png            the heart of two figures alone, black and purple
// Run `node scripts/design/brand-assets.mjs` to redraw what this writes:
//   public/brand/tipme-{wordmark,mark}-{ink,accent}.png  the site's logo as two masks (brand.tsx):
//     the black part and the purple part, so CSS gives each its colour (white on the purple
//     receipt page and in the dark Studio headers, a style's own ink and accent)
//   public/icons/*.png  tab, home-screen and Apple icons: the heart on a white rounded tile
//   public/favicon.ico  the 32 and 48 px tab icons, for browsers that ask for /favicon.ico
//   public/email/tipme-logo-2026-{light,dark}-{2x,3x}.png  the email header (packages/mail layout.ts);
//     the old tipme-logo-* files are left alone for emails already sent
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Sharp lives with the API (as in covers.mjs); this script needs no package of its own.
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');
const pub = (path) =>
  fileURLToPath(new URL(`../../apps/web/public/${path}`, import.meta.url));

const PURPLE = [0x7a, 0x32, 0xf9];
const WHITE = '#FFFFFF'; // --surface-base
const PNG = { compressionLevel: 9, effort: 10 };

/**
 * One RGBA picture (black and purple, any alpha) as two alpha masks: ink (the black) and accent
 * (the purple). Drawn ink first and accent over it, in black and purple, they give the picture
 * back; an edge pixel between the two is shared by how purple it is.
 */
export function splitInkAccent(data) {
  const pixels = data.length / 4;
  const ink = Buffer.alloc(pixels * 4);
  const accent = Buffer.alloc(pixels * 4);
  const pp = PURPLE[0] ** 2 + PURPLE[1] ** 2 + PURPLE[2] ** 2;
  for (let i = 0; i < pixels; i += 1) {
    const [r, g, b, a8] = data.subarray(i * 4, i * 4 + 4);
    const a = a8 / 255;
    const t = Math.min(
      1,
      Math.max(0, (r * PURPLE[0] + g * PURPLE[1] + b * PURPLE[2]) / pp),
    );
    const accentA = a * t;
    const inkA = accentA >= 1 ? 0 : (a * (1 - t)) / (1 - accentA);
    // White masks: only the alpha counts (mask-mode: alpha); white keeps them viewable.
    ink.fill(255, i * 4, i * 4 + 3);
    accent.fill(255, i * 4, i * 4 + 3);
    ink[i * 4 + 3] = Math.round(inkA * 255);
    accent[i * 4 + 3] = Math.round(accentA * 255);
  }
  return { ink, accent };
}

async function masks(source, name, height) {
  const { data, info } = await sharp(pub(`brand/${source}`))
    .resize({ height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const parts = splitInkAccent(data);
  for (const part of ['ink', 'accent']) {
    const out = await sharp(parts[part], {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png(PNG)
      .toFile(pub(`brand/${name}-${part}.png`));
    console.log(name, part, out.width, out.height, out.size);
  }
}

/** The heart centred on a white tile: `mark` of the side wide, corners rounded by `radius`. */
async function iconTile(file, side, { mark, radius }) {
  const markWidth = Math.round(side * mark);
  const heart = await sharp(pub('brand/tipme-mark.png'))
    .resize({ width: markWidth })
    .png()
    .toBuffer();
  const { height: markHeight } = await sharp(heart).metadata();
  const r = side * radius;
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><rect width="${side}" height="${side}" rx="${r}" ry="${r}" fill="${WHITE}"/></svg>`,
  );
  const out = await sharp(tile)
    .composite([
      {
        input: heart,
        left: Math.round((side - markWidth) / 2),
        // Optically centred: the heads make the top look heavier, so a hair lower.
        top: Math.round((side - markHeight) / 2 + side * 0.01),
      },
    ])
    .png(PNG)
    .toFile(pub(`icons/${file}`));
  console.log(file, out.width, out.height, out.size);
}

/** An .ico holding PNG images (allowed since Windows Vista; every current browser reads it). */
export function icoOf(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ side, png }, i) => {
    const at = 6 + i * 16;
    header[at] = side; // width (0 would mean 256)
    header[at + 1] = side; // height
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map(({ png }) => png)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Masks 240 px tall: the header draws the logo 40 px tall, so 6x at 1x and 2x at 3x.
  await masks('tipme-wordmark-light.png', 'tipme-wordmark', 240);
  await masks('tipme-mark.png', 'tipme-mark', 240);

  mkdirSync(pub('icons'), { recursive: true });
  // The tab (32, 48) and Android (192) icons: rounded, as the old tab icon (28 of 120). The white
  // tile keeps the black figure readable on a dark tab strip.
  for (const side of [32, 48])
    await iconTile(`favicon-${side}.png`, side, {
      mark: 0.78,
      radius: 28 / 120,
    });
  writeFileSync(
    pub('favicon.ico'),
    icoOf(
      [32, 48].map((side) => ({
        side,
        png: readFileSync(pub(`icons/favicon-${side}.png`)),
      })),
    ),
  );
  await iconTile('192.png', 192, { mark: 0.72, radius: 28 / 120 });
  // Full bleed: iOS rounds its own; maskable is cropped by the platform, so the heart stays well
  // inside the centre safe circle (radius 40%): half its diagonal is about 34% here.
  await iconTile('apple-touch-icon.png', 180, { mark: 0.64, radius: 0 });
  await iconTile('512-maskable.png', 512, { mark: 0.5, radius: 0 });

  // Email: shown 160 x 44 (packages/mail layout.ts LOGO_W, LOGO_H); 2x is loaded, 3x kept.
  for (const scheme of ['light', 'dark'])
    for (const [scale, width] of [
      ['2x', 320],
      ['3x', 480],
    ]) {
      const out = await sharp(pub(`brand/tipme-wordmark-${scheme}.png`))
        .resize({ width })
        .png({ ...PNG, palette: true, colours: 256 })
        .toFile(pub(`email/tipme-logo-2026-${scheme}-${scale}.png`));
      console.log(scheme, scale, out.width, out.height, out.size);
    }
}
