// The cover artwork (design spec section 6): eighteen original generative patterns, authored
// here and not traced from any source. Run `node scripts/design/covers.mjs` to redraw
// apps/web/public/covers/*.webp (2240 x 600). Adire and aso-oke influenced two of them.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const W = 1120,
  H = 300;
const svgs = new Map();
const rng = (seed) => () =>
  (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const f = (n) => +n.toFixed(2);
const HP =
  'M701.259 76.9553L701.236 77.167C737.151 92.0868 770.727 77.7807 769.62 56.2653C768.512 34.7487 741.619 36.1332 741.619 36.1332L741.525 36.0404C741.525 36.0404 742.479 9.12833 720.948 8.36497C699.419 7.60052 685.767 41.2835 701.259 76.9553Z';
const heart = (x, y, s, fill, rot = 0, extra = '') =>
  `<path transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(s / 73)}) translate(-733 -45)" d="${HP}" fill="${fill}" ${extra}/>`;
const inHeart = (px, py, cx, cy, s) => {
  const x = (px - cx) / s,
    y = -(py - cy) / s + 0.1;
  const a = x * x + y * y - 0.25;
  return a * a * a - x * x * y * y * y * 1.0 <= 0;
};
const noise = (seed) => {
  const r = rng(seed),
    g = [];
  for (let i = 0; i < 256; i++) g[i] = r();
  const v = (x, y) =>
    g[(((Math.floor(x) * 57 + Math.floor(y) * 131) % 256) + 256) % 256];
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      u = sm(x - xi),
      w = sm(y - yi);
    const a = v(xi, yi),
      b = v(xi + 1, yi),
      c = v(xi, yi + 1),
      d = v(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
};
const save = (name, bg, body, defs = '') =>
  svgs.set(
    name,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${defs ? `<defs>${defs}</defs>` : ''}<rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`,
  );

// 1. Indigo Grid: an original grid of hand-feeling resist marks, influenced by adire's square layouts.
{
  const r = rng(11),
    ink = '#f4f1e8',
    cell = 100;
  let b = '';
  const j = (a = 1.6) => (r() - 0.5) * a;
  const motif = (x, y, kind) => {
    const c = x + cell / 2,
      d = y + cell / 2;
    let s = '';
    if (kind === 0)
      for (const q of [38, 26, 14])
        s += `<circle cx="${f(c + j())}" cy="${f(d + j())}" r="${q}" fill="none" stroke="${ink}" stroke-width="4"/>`;
    if (kind === 1)
      for (let i = 0; i < 6; i++)
        s += `<path d="M${f(x + 14 + i * 14 + j())} ${y + 14}V${y + 86}" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`;
    if (kind === 2) s += heart(c, d, 58, ink, -10 + j(10));
    if (kind === 3)
      for (let i = 0; i < 4; i++)
        s += `<path d="M${x + 12} ${y + 24 + i * 18}l19 -13 19 13 19 -13 19 13" fill="none" stroke="${ink}" stroke-width="4.500" stroke-linejoin="round"/>`;
    if (kind === 4)
      for (let i = 0; i < 5; i++)
        for (let k = 0; k < 5; k++)
          s += `<circle cx="${f(x + 18 + i * 16 + j())}" cy="${f(y + 18 + k * 16 + j())}" r="${f(3.4 + j(1))}" fill="${ink}"/>`;
    if (kind === 5)
      s += `<path d="M${c} ${y + 12}L${x + 88} ${d}L${c} ${y + 88}L${x + 12} ${d}Z" fill="none" stroke="${ink}" stroke-width="5"/><path d="M${c} ${y + 32}L${x + 68} ${d}L${c} ${y + 68}L${x + 32} ${d}Z" fill="${ink}"/>`;
    if (kind === 6)
      for (let i = 0; i < 12; i++) {
        const t = (i / 12) * 6.283;
        s += `<path d="M${f(c + Math.cos(t) * 14)} ${f(d + Math.sin(t) * 14)}L${f(c + Math.cos(t) * 40)} ${f(d + Math.sin(t) * 40)}" stroke="${ink}" stroke-width="4.500" stroke-linecap="round"/>`;
      }
    if (kind === 7)
      for (let i = 0; i < 5; i++)
        s += `<path d="M${x + 12} ${y + 18 + i * 16}q19 -12 38 0t38 0" fill="none" stroke="${ink}" stroke-width="4.500"/>`;
    return s;
  };
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 12; col++) {
      b += motif(
        col * cell - 40,
        row * cell,
        (row * 3 + col * 5 + (col % 2)) % 8,
      );
      b += `<path d="M${col * cell - 40} ${row * cell}h${cell}M${col * cell - 40} ${row * cell}v${cell}" stroke="${ink}" stroke-width="2.500" opacity=".75"/>`;
    }
  save('indigo', '#1b2a63', b);
}

// 2. Woven Strips: narrow joined strips with warp stripes, influenced by aso-oke's strip weaving.
{
  const r = rng(23);
  const pal = [
    '#5b1230',
    '#c79a2e',
    '#f1e6cf',
    '#1c1a2e',
    '#8c2f39',
    '#d9b65c',
  ];
  let b = '';
  const stripW = 74;
  for (let s = 0; s * stripW < W; s++) {
    const x = s * stripW,
      base = pal[s % 2 ? 0 : 3];
    b += `<rect x="${x}" width="${stripW}" height="${H}" fill="${base}"/>`;
    let u = 3;
    while (u < stripW - 3) {
      const w = 2 + Math.floor(r() * 9);
      b += `<rect x="${x + u}" width="${w}" height="${H}" fill="${pal[Math.floor(r() * pal.length)]}"/>`;
      u += w + 2 + Math.floor(r() * 4);
    }
    for (let y = (s % 3) * 26; y < H; y += 52 + (s % 4) * 8)
      b += `<rect x="${x + 6}" y="${y}" width="${stripW - 12}" height="10" fill="${pal[(s + 2) % pal.length]}"/>`;
    b += `<rect x="${x}" width="1.200" height="${H}" fill="#000" opacity=".5"/>`;
  }
  save('woven', '#1c1a2e', b);
}

// 3. Danfo: the yellow and black of Lagos road life, as one fast diagonal.
{
  let b = '';
  for (let i = -2; i < 10; i++)
    b += `<path d="M${560 + i * 74} 300L${690 + i * 74} 0h34L${594 + i * 74} 300Z" fill="#0b0b0b"/>`;
  b += `<path d="M0 214H1120V236H0Z" fill="#0b0b0b"/><path d="M0 248H1120V256H0Z" fill="#0b0b0b"/>`;
  save('danfo', '#f7c600', b);
}

// 4. Harmattan: a pale sun in dusty haze over layered ridges.
{
  const n = noise(5);
  let b = '<circle cx="600" cy="130" r="94" fill="#fff0cf"/>';
  const cols = ['#eda35f', '#d67c3f', '#b05a2d', '#7f3d21', '#4b2315'];
  cols.forEach((c, i) => {
    let d = `M0 ${H}`;
    for (let x = 0; x <= W; x += 10)
      d += `L${x} ${f(120 + i * 34 + n(x / (170 - i * 18) + i * 7, i * 3) * 58)}`;
    b += `<path d="${d}L${W} ${H}Z" fill="${c}"/>`;
  });
  save('harmattan', '#f6c889', b, '');
}

// 5. Lagoon: many fine lines on deep water.
{
  const n = noise(9);
  let b = '';
  for (let i = 0; i < 46; i++) {
    let d = '';
    const y0 = -10 + i * 7.2;
    for (let x = 0; x <= W; x += 12)
      d += `${x ? 'L' : 'M'}${x} ${f(y0 + (n(x / 190, i / 8) - 0.5) * 92)}`;
    b += `<path d="${d}" fill="none" stroke="#7fe0d2" stroke-width="1.300" opacity="${f(0.25 + (i / 46) * 0.7)}"/>`;
  }
  save('lagoon', '#06343d', b);
}

// 6. Engraved: a guilloche rosette, like fine security printing, with no currency imagery.
{
  let b = '';
  const rose = (cx, cy, R, a, k, col, sw) => {
    for (let t = 0; t < 8; t++) {
      let d = '';
      const ph = (t / 8) * 6.283;
      for (let i = 0; i <= 720; i += 2) {
        const th = (i / 720) * 6.283;
        const r = R * (0.62 + a * Math.sin(k * th + ph));
        d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(th))} ${f(cy + r * Math.sin(th))}`;
      }
      b += `<path d="${d}Z" fill="none" stroke="${col}" stroke-width="${sw}"/>`;
    }
  };
  rose(560, 150, 250, 0.3, 7, '#7a32f9', 2);
  rose(1040, 40, 140, 0.28, 5, '#b897ff', 2);
  rose(120, 300, 140, 0.28, 5, '#b897ff', 2);
  save('engraved', '#f4eeff', b);
}

// 7. Contour: a map of an imaginary hill, lines from a height field by marching squares.
{
  const n = noise(31);
  const g = 12,
    cols = Math.ceil(W / g) + 1,
    rows = Math.ceil(H / g) + 1;
  const hgt = [];
  for (let y = 0; y < rows; y++) {
    hgt[y] = [];
    for (let x = 0; x < cols; x++)
      hgt[y][x] = n(x / 16, y / 16) * 0.65 + n(x / 7 + 9, y / 7) * 0.35;
  }
  let b = '';
  for (let lv = 0.16; lv < 0.9; lv += 0.052) {
    let d = '';
    const it = (a, c) => (lv - a) / (c - a);
    for (let y = 0; y < rows - 1; y++)
      for (let x = 0; x < cols - 1; x++) {
        const a = hgt[y][x],
          c = hgt[y][x + 1],
          e = hgt[y + 1][x + 1],
          h = hgt[y + 1][x];
        const pts = [];
        if (a < lv !== c < lv) pts.push([(x + it(a, c)) * g, y * g]);
        if (c < lv !== e < lv) pts.push([(x + 1) * g, (y + it(c, e)) * g]);
        if (h < lv !== e < lv) pts.push([(x + it(h, e)) * g, (y + 1) * g]);
        if (a < lv !== h < lv) pts.push([x * g, (y + it(a, h)) * g]);
        if (pts.length >= 2)
          d += `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
        if (pts.length === 4)
          d += `M${f(pts[2][0])} ${f(pts[2][1])}L${f(pts[3][0])} ${f(pts[3][1])}`;
      }
    b += `<path d="${d}" fill="none" stroke="#b9e3b0" stroke-width="1.200" opacity=".85"/>`;
  }
  save('contour', '#123527', b);
}

// 8. Overprint: a two-colour dot screen forming a heart, in the spirit of risograph printing.
{
  let b = '';
  const screen = (col, dx, dy, ang, step) => {
    const c = Math.cos(ang),
      s = Math.sin(ang);
    for (let u = -80; u < 110; u++)
      for (let v = -80; v < 110; v++) {
        const x = 560 + (u * c - v * s) * step + dx,
          y = 150 + (u * s + v * c) * step + dy;
        if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
        const inside = inHeart(x, y, 560 + dx, 150 + dy, 220);
        const fade = Math.max(
          0,
          1 - Math.hypot(x - 560, (y - 150) * 1.4) / 560,
        );
        if (!inside && fade < 0.22) continue;
        const r = inside ? step * 0.48 : step * 0.13 * fade + 0.6;
        b += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${col}"/>`;
      }
  };
  b += '<g style="mix-blend-mode:multiply">';
  screen('#ff4d6d', -7, 5, 0.5, 15);
  b += '</g><g style="mix-blend-mode:multiply">';
  screen('#2747d9', 7, -5, 1.1, 15);
  b += '</g>';
  save('overprint', '#fbf5e6', b);
}

// 9. Sunburst: deco rays from below.
{
  let b = '';
  const cx = 560,
    cy = 330;
  for (let i = 0; i < 44; i += 2) {
    const a = Math.PI + (i / 44) * Math.PI,
      c = Math.PI + ((i + 1) / 44) * Math.PI;
    b += `<path d="M${cx} ${cy}L${f(cx + 1500 * Math.cos(a))} ${f(cy + 1500 * Math.sin(a))}L${f(cx + 1500 * Math.cos(c))} ${f(cy + 1500 * Math.sin(c))}Z" fill="#e0b24a"/>`;
  }
  for (const [r, c] of [
    [170, '#14110d'],
    [142, '#e0b24a'],
    [120, '#14110d'],
    [66, '#7a32f9'],
  ])
    b += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
  save('sunburst', '#14110d', b);
}

// 10. Geometry: bold quarter circles on a modernist tile.
{
  const r = rng(44),
    s = 100;
  const pal = [
    '#f2542d',
    '#0e9594',
    '#f5dfbb',
    '#127475',
    '#562c2c',
    '#f2a65a',
  ];
  let b = '';
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 12; x++) {
      const X = x * s - 40,
        Y = y * s,
        bg = pal[Math.floor(r() * 6)];
      let fg = pal[Math.floor(r() * 6)];
      if (fg === bg) fg = '#f5dfbb' === bg ? '#562c2c' : '#f5dfbb';
      b += `<rect x="${X}" y="${Y}" width="${s}" height="${s}" fill="${bg}"/>`;
      const k = Math.floor(r() * 5);
      if (k === 0)
        b += `<path d="M${X} ${Y}A${s} ${s} 0 0 1 ${X + s} ${Y + s}L${X} ${Y + s}Z" fill="${fg}"/>`;
      if (k === 1)
        b += `<path d="M${X + s} ${Y}A${s} ${s} 0 0 1 ${X} ${Y + s}L${X + s} ${Y + s}Z" fill="${fg}"/>`;
      if (k === 2)
        b += `<circle cx="${X + 50}" cy="${Y + 50}" r="38" fill="${fg}"/>`;
      if (k === 3)
        b += `<path d="M${X} ${Y + 50}A50 50 0 0 1 ${X + 100} ${Y + 50}Z" fill="${fg}"/>`;
      if (k === 4) b += heart(X + 50, Y + 50, 66, fg);
    }
  save('geometry', '#f5dfbb', b);
}

// 11. Vinyl: grooves of a record, for people who make music.
{
  let b = '';
  const cx = 620,
    cy = 150;
  for (let r = 90; r < 900; r += 5)
    b += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width=".8" opacity="${f(0.05 + (r % 35 === 0 ? 0.16 : 0.04))}"/>`;
  b += `<path d="M${cx} ${cy}L${W + 80} -160L${W + 240} 0Z" fill="#fff" opacity=".07"/><path d="M${cx} ${cy}L-120 ${H + 200}L-260 ${H + 40}Z" fill="#fff" opacity=".05"/>`;
  b += `<circle cx="${cx}" cy="${cy}" r="84" fill="#7a32f9"/><circle cx="${cx}" cy="${cy}" r="11" fill="#0c0c0e"/>`;
  save('vinyl', '#0c0c0e', b);
}

// 12. Terrazzo: stone chips set in warm plaster.
{
  const r = rng(61),
    pal = [
      '#7a32f9',
      '#d9c3ff',
      '#2b2b2b',
      '#c9603a',
      '#f3b74a',
      '#8fa89b',
      '#ffffff',
    ];
  let b = '';
  for (let i = 0; i < 300; i++) {
    const x = r() * W,
      y = r() * H,
      R = 6 + r() * r() * 34,
      k = 4 + Math.floor(r() * 3),
      a0 = r() * 6.28;
    let d = '';
    for (let q = 0; q < k; q++) {
      const a = a0 + (q / k) * 6.283,
        l = R * (0.6 + r() * 0.5);
      d += `${q ? 'L' : 'M'}${f(x + Math.cos(a) * l)} ${f(y + Math.sin(a) * l)}`;
    }
    b += `<path d="${d}Z" fill="${pal[Math.floor(r() * pal.length)]}"/>`;
  }
  save('terrazzo', '#ece6da', b);
}

// 13. Paper Hearts: stacked cut paper with soft edges.
{
  let b = '';
  const tones = [
    '#4d16a8',
    '#5b1ec4',
    '#6723e8',
    '#7a32f9',
    '#9a63fb',
    '#bd9bfd',
    '#e0d0ff',
  ];
  tones.forEach((c, i) => {
    const s = 900 - i * 118;
    b += heart(
      580,
      200 - i * 8,
      s,
      'rgba(20,0,60,.28)',
      -8 + i * 2,
      `style="transform-origin:0 0"`,
    );
    b += heart(580, 192 - i * 8, s, c, -8 + i * 2);
  });
  save('paper', '#3a1085', b);
}

// 14. Waveform: a loud bar of sound.
{
  const n = noise(71);
  let b = '';
  for (let x = 8; x < W; x += 10) {
    const e = 0.25 + 0.75 * Math.abs(Math.sin(x / 130)) * n(x / 40, 2);
    const h = 16 + e * 250;
    b += `<rect x="${x}" y="${f(150 - h / 2)}" width="5" height="${f(h)}" rx="2.500" fill="#ff5c8a"/>`;
  }
  save('waveform', '#1a0b2e', b);
}

// 15. City Lights: soft points of light on a night road.
{
  const r = rng(83),
    pal = ['#ffd166', '#ff7b54', '#ffffff', '#7a32f9', '#35c2c1'];
  let b = '';
  for (let i = 0; i < 90; i++) {
    const R = 4 + r() * r() * 46;
    b += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(R)}" fill="${pal[Math.floor(r() * 5)]}" opacity="${f(0.1 + r() * 0.32)}"/>`;
  }
  for (let i = 0; i < 160; i++)
    b += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(0.7 + r() * 1.5)}" fill="#fff" opacity=".8"/>`;
  save('citylights', '#0a1230', b);
}

// 16. Op Check: a checkerboard bent around a swell.
{
  let b = '';
  const s = 34;
  const warp = (x, y) => {
    const dx = x - 560,
      dy = y - 150,
      q = Math.hypot(dx, dy),
      k = 1 + 90 / (q + 90);
    return [560 + dx * k, 150 + dy * k];
  };
  for (let j = -2; j < 13; j++)
    for (let i = -8; i < 42; i++) {
      if ((i + j) % 2) continue;
      const X = i * s,
        Y = j * s;
      const p = [
        warp(X, Y),
        warp(X + s, Y),
        warp(X + s, Y + s),
        warp(X, Y + s),
      ];
      b += `<path d="M${p.map((a) => `${f(a[0])} ${f(a[1])}`).join('L')}Z" fill="#000"/>`;
    }
  save('opcheck', '#f6f4ee', b);
}

// 17. Flow: threads following an invisible current.
{
  const n = noise(97),
    r = rng(5),
    pal = ['#f2542d', '#f6c344', '#ffffff', '#35c2c1'];
  let b = '';
  for (let i = 0; i < 230; i++) {
    let x = r() * W,
      y = r() * H,
      d = `M${f(x)} ${f(y)}`;
    for (let k = 0; k < 42; k++) {
      const a = n(x / 150, y / 150) * 6.283 * 2;
      x += Math.cos(a) * 7;
      y += Math.sin(a) * 7;
      d += `L${f(x)} ${f(y)}`;
    }
    b += `<path d="${d}" fill="none" stroke="${pal[i % 4]}" stroke-width="1.400" opacity=".7" stroke-linecap="round"/>`;
  }
  save('flow', '#15172b', b);
}

// 18. Confetti Hearts: a celebration, tossed.
{
  const r = rng(101),
    pal = ['#7a32f9', '#ff5c8a', '#f6c344', '#35c2c1', '#000000'];
  let b = '';
  const placed = [];
  for (let i = 0, tries = 0; i < 60 && tries < 4000; tries++) {
    const x = r() * W,
      y = r() * H,
      s = 16 + r() * 40;
    if (placed.some(([a, c, t]) => Math.hypot(a - x, c - y) < (t + s) * 0.72))
      continue;
    placed.push([x, y, s]);
    b += heart(x, y, s, pal[i % 5], r() * 70 - 35);
    i++;
  }
  save('confetti', '#fffaf0', b);
}

// Sharp lives with the API, which already re-encodes uploads; this script needs no package of its own.
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');
const out = fileURLToPath(
  new URL('../../apps/web/public/covers/', import.meta.url),
);
// Quality per design: vector art compresses well, but the dense line work (engraved, overprint)
// is lowered only as far as the 120 KB budget needs.
const QUALITY = { engraved: 70, overprint: 60, lagoon: 68 };
const only = process.argv.slice(2);
mkdirSync(out, { recursive: true });
for (const [name, svg] of svgs) {
  if (only.length && !only.includes(name)) continue;
  // density 144 draws the 1120 x 300 artboard at 2240 x 600.
  const info = await sharp(Buffer.from(svg), { density: 144 })
    .webp({ quality: QUALITY[name] ?? 82, effort: 6 })
    .toFile(`${out}${name}.webp`);
  console.log(name, info.width, info.height, info.size);
}
