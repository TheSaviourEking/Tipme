// The TipMe logo for email (packages/mail layout.ts): Gmail and others strip SVG, so the owner's
// two SVGs (778 x 293: light has a black "tip", dark a white one) are drawn to PNG. The email shows
// them 120 px wide; 2x (240) is what it loads, 3x (360) is kept for sharper uses.
// Run `node scripts/design/email-logo.mjs` to redraw apps/web/public/email/*.png.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Sharp lives with the API (as in covers.mjs); this script needs no package of its own.
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');
const dir = fileURLToPath(
  new URL('../../apps/web/public/email/', import.meta.url),
);

for (const scheme of ['light', 'dark']) {
  const svg = readFileSync(`${dir}tipme-logo-${scheme}.svg`);
  for (const [scale, width] of [
    ['2x', 240],
    ['3x', 360],
  ]) {
    // Drawn large then reduced, for smooth edges; transparent; a 256-colour palette keeps it small.
    const info = await sharp(svg, { density: 300 })
      .resize({ width })
      .png({ palette: true, colours: 256, effort: 10, compressionLevel: 9 })
      .toFile(`${dir}tipme-logo-${scheme}-${scale}.png`);
    console.log(scheme, scale, info.width, info.height, info.size);
  }
}
