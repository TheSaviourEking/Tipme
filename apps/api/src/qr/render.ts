import QRCode from 'qrcode';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import { QR_ART, type QrArtId } from './catalogue.js';
import { CARD_PANEL, cardFrame, type CardCover } from './covers-for-cards.js';
import {
  MOSAIC_QUIET,
  QrArtPhotoRequiredError,
  QrArtPhotoTooLargeError,
  drawMosaic,
} from './mosaic.js';

export { QR_ART, QrArtPhotoRequiredError, QrArtPhotoTooLargeError };

// Draws the Pro QR designs on the server, so the browser never holds the drawing code. Every mark
// is an outlined path: the API image has no fonts to rely on. Function modules (finder, separator,
// timing, format, version and every alignment pattern) stay whole in every design, since a reader
// finds and reads the code by them; the design only reshapes the data modules.

const MIN_SIZE = 64;
// The card frames' own size: anything larger would only blur their artwork.
const MAX_SIZE = 1400;
const MAX_URL_LENGTH = 300;
// The H-level version the mosaic uses first reaches this many modules at version 7, where a row of
// extra alignment patterns crosses the middle of the picture.
export const MOSAIC_FACE_ALIGNMENT_MODULES = 45;
const f = (n: number) => +n.toFixed(3);
const rng = (seed: number) => () =>
  (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const HEART =
  'M.09 .86C.07 .86 .05 .9 .09 .94C.48 1.1 .92 .94 .91 .66C.89 .38 .55 .4 .55 .4C.55 .4 .56 .06 .28 .05C0 .04 -.17 .47 .03 .93Z';
const COVER_HEART =
  'M701.259 76.9553L701.236 77.167C737.151 92.0868 770.727 77.7807 769.62 56.2653C768.512 34.7487 741.619 36.1332 741.619 36.1332L741.525 36.0404C741.525 36.0404 742.479 9.12833 720.948 8.36497C699.419 7.60052 685.767 41.2835 701.259 76.9553Z';

export interface QrGrid {
  n: number;
  version: number;
  dark(a: number, b: number): boolean;
  reserved(a: number, b: number): boolean;
}

function makeGrid(url: string, ec: 'H' | 'Q'): QrGrid {
  const { modules, version } = QRCode.create(url, {
    errorCorrectionLevel: ec,
  });
  const n = modules.size;
  return {
    n,
    version,
    dark: (a, b) => modules.data[a * n + b] === 1,
    reserved: (a, b) => modules.reservedBit[a * n + b] === 1,
  };
}

const inFinder = (n: number, a: number, b: number) =>
  (a < 7 && b < 7) || (a < 7 && b >= n - 7) || (a >= n - 7 && b < 7);

type FinderStyle = 'round' | 'square' | 'circle' | 'leaf';
type Draw = (a: number, b: number, paint: string) => string;
interface Ctx {
  paint: string;
  /** A data module at this place that the design draws (not covered by a mark). */
  on(a: number, b: number): boolean;
}
type Shape = (ctx: Ctx, seed: () => number) => Draw;

function finder(
  x: number,
  y: number,
  ink: string,
  style: FinderStyle,
  corner: 'tr' | 'br' | 'bl',
): string {
  if (style === 'circle')
    return `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="3" fill="none" stroke="${ink}"/><circle cx="${x + 3.5}" cy="${y + 3.5}" r="1.5" fill="${ink}"/>`;
  if (style === 'leaf') {
    // Rounded on three corners, sharp on the one facing the centre of the code.
    const leaf = (cx: number, cy: number, s: number) => {
      const h = s / 2;
      const r = f(s * 0.42);
      const point = {
        tl: [cx - h, cy - h],
        tr: [cx + h, cy - h],
        br: [cx + h, cy + h],
        bl: [cx - h, cy + h],
      } as const;
      const turn = (
        name: keyof typeof point,
        from: readonly [number, number],
        to: readonly [number, number],
      ) =>
        name === corner
          ? `L${point[name][0]} ${point[name][1]}`
          : `L${f(from[0])} ${f(from[1])}Q${point[name][0]} ${point[name][1]} ${f(to[0])} ${f(to[1])}`;
      return (
        `M${cx} ${cy - h}` +
        turn('tr', [cx + h - r, cy - h], [cx + h, cy - h + r]) +
        turn('br', [cx + h, cy + h - r], [cx + h - r, cy + h]) +
        turn('bl', [cx - h + r, cy + h], [cx - h, cy + h - r]) +
        turn('tl', [cx - h, cy - h + r], [cx - h + r, cy - h]) +
        'Z'
      );
    };
    return `<path d="${leaf(x + 3.5, y + 3.5, 6)}" fill="none" stroke="${ink}"/><path d="${leaf(x + 3.5, y + 3.5, 3)}" fill="${ink}"/>`;
  }
  const r = style === 'square' ? 0 : 1.4;
  return `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="${r}" fill="none" stroke="${ink}"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="${r / 2}" fill="${ink}"/>`;
}

const square: Shape = () => (a, b, paint) =>
  `<rect x="${b}" y="${a}" width="1.02" height="1.02" fill="${paint}"/>`;
const round =
  (rx = 0.3): Shape =>
  () =>
  (a, b, paint) =>
    `<rect x="${f(b + 0.04)}" y="${f(a + 0.04)}" width=".92" height=".92" rx="${rx}" fill="${paint}"/>`;
const dot: Shape = () => (a, b, paint) =>
  `<circle cx="${b + 0.5}" cy="${a + 0.5}" r=".5" fill="${paint}"/>`;
const heart: Shape = () => (a, b, paint) =>
  `<path transform="translate(${f(b - 0.06)} ${f(a - 0.04)}) scale(1.12)" d="${HEART}" fill="${paint}"/>`;
const hbar: Shape = (ctx) => (a, b, paint) => {
  if (ctx.on(a, b - 1)) return '';
  let len = 1;
  while (ctx.on(a, b + len)) len++;
  return `<rect x="${f(b + 0.04)}" y="${f(a + 0.08)}" width="${f(len - 0.08)}" height=".84" rx=".42" fill="${paint}"/>`;
};
const vbar: Shape = (ctx) => (a, b, paint) => {
  if (ctx.on(a - 1, b)) return '';
  let len = 1;
  while (ctx.on(a + len, b)) len++;
  return `<rect x="${f(b + 0.08)}" y="${f(a + 0.04)}" width=".84" height="${f(len - 0.08)}" rx=".42" fill="${paint}"/>`;
};
const diamond: Shape = () => (a, b, paint) => {
  const x = b + 0.5;
  const y = a + 0.5;
  const r = 0.68;
  return `<path d="M${x} ${f(y - r)}L${f(x + r)} ${y}L${x} ${f(y + r)}L${f(x - r)} ${y}Z" fill="${paint}"/>`;
};
const sparkle: Shape = () => (a, b, paint) => {
  const x = b + 0.5;
  const y = a + 0.5;
  const r = 0.72;
  const k = 0.08;
  return `<path d="M${x} ${f(y - r)}Q${f(x + k)} ${f(y - k)} ${f(x + r)} ${y}Q${f(x + k)} ${f(y + k)} ${x} ${f(y + r)}Q${f(x - k)} ${f(y + k)} ${f(x - r)} ${y}Q${f(x - k)} ${f(y - k)} ${x} ${f(y - r)}Z" fill="${paint}"/>`;
};
const key: Shape = () => (a, b, paint) =>
  `<rect x="${f(b + 0.12)}" y="${f(a + 0.2)}" width=".9" height=".9" rx=".22" fill="#c9aeff"/><rect x="${f(b + 0.03)}" y="${f(a + 0.03)}" width=".9" height=".9" rx=".22" fill="${paint}"/>`;
const stitch: Shape = () => (a, b, paint) =>
  `<path d="M${f(b + 0.08)} ${f(a + 0.08)}L${f(b + 0.92)} ${f(a + 0.92)}M${f(b + 0.92)} ${f(a + 0.08)}L${f(b + 0.08)} ${f(a + 0.92)}" stroke="${paint}" stroke-width=".42" stroke-linecap="round"/>`;
const JEWELS = ['#4d16a8', '#8f2746', '#1d4e89', '#1f4d3a'] as const;
const jewel: Shape = () => (a, b) =>
  `<rect x="${f(b + 0.03)}" y="${f(a + 0.03)}" width=".94" height=".94" rx=".2" fill="${JEWELS[Math.floor((Math.sin(a / 5) + Math.cos(b / 6) + 2) * 0.999)] ?? JEWELS[3]}"/>`;
const CHIPS = ['#000000', '#2b0a5c', '#7a2a12', '#123527'] as const;
const chip: Shape = (_, r) => (a, b) => {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * 6.283 + r();
    const l = 0.52 + r() * 0.2;
    d += `${i ? 'L' : 'M'}${f(b + 0.5 + Math.cos(t) * l)} ${f(a + 0.5 + Math.sin(t) * l)}`;
  }
  return `<path d="${d}Z" fill="${CHIPS[Math.floor(r() * 4)]}"/>`;
};

interface BareRecipe {
  type: 'bare';
  ec: 'H' | 'Q';
  ink: string;
  gradient?: readonly [string, string];
  shape: Shape;
  finder: FinderStyle;
  /** Pale hearts behind the code: never near reading contrast. */
  petals?: boolean;
  /** A naira sign in a cleared circle. */
  naira?: boolean;
  /** Dots growing the square code into a silhouette, keeping a clear gap around it. */
  silhouette?: (u: number, v: number) => boolean;
}
interface CardRecipe {
  type: 'card';
  cover: CardCover;
  ink: string;
  shape: Shape;
  finder: FinderStyle;
}
type Recipe = BareRecipe | CardRecipe | { type: 'mosaic' };

const bare = (
  ec: 'H' | 'Q',
  ink: string,
  shape: Shape,
  finder: FinderStyle,
  more: Partial<BareRecipe> = {},
): BareRecipe => ({ type: 'bare', ec, ink, shape, finder, ...more });
const card = (
  cover: CardCover,
  ink: string,
  shape: Shape,
  finder: FinderStyle = 'round',
): CardRecipe => ({ type: 'card', cover, ink, shape, finder });

const RECIPES: Record<QrArtId, Recipe> = {
  heart: bare('H', '#4d16a8', heart, 'round'),
  jewel: bare('Q', '#2b0a5c', jewel, 'round'),
  stitch: bare('H', '#8f2746', stitch, 'square'),
  keys: bare('H', '#2b0a5c', key, 'round'),
  petals: bare('H', '#3a1085', dot, 'round', { petals: true }),
  chips: bare('H', '#000000', chip, 'round'),
  coin: bare('H', '#000000', dot, 'circle', {
    silhouette: (u, v) => Math.hypot(u - 0.5, v - 0.5) < 0.5,
  }),
  heartshape: bare('H', '#7a32f9', dot, 'circle', {
    silhouette: (u, v) => {
      const x = (u - 0.5) * 2.5;
      const y = -(v - 0.54) * 2.5;
      const k = x * x + y * y - 1;
      return k * k * k - x * x * y * y * y <= 0;
    },
  }),
  liquid: bare('Q', '#000000', hbar, 'round'),
  pillars: bare('Q', '#4d16a8', vbar, 'round'),
  diamond: bare('Q', '#1d4e89', diamond, 'square'),
  sparkle: bare('H', '#000000', sparkle, 'round'),
  circles: bare('Q', '#1f4d3a', dot, 'circle'),
  leaf: bare('Q', '#4d16a8', round(), 'leaf'),
  dusk: bare('Q', '#4d16a8', dot, 'round', {
    gradient: ['#4d16a8', '#a82a55'],
  }),
  lagoon: bare('Q', '#1f4d3a', hbar, 'circle', {
    gradient: ['#1f4d3a', '#1d4e89'],
  }),
  naira: bare('H', '#000000', round(), 'leaf', { naira: true }),
  mosaic: { type: 'mosaic' },
  indigo: card('indigo', '#1b2a63', round()),
  woven: card('woven', '#5b1230', square, 'square'),
  danfo: card('danfo', '#0b0b0b', square, 'square'),
  harmattan: card('harmattan', '#7f3d21', dot),
  lagooncard: card('lagoon', '#06343d', dot, 'circle'),
  citylights: card('citylights', '#0a1230', dot, 'circle'),
  vinyl: card('vinyl', '#000000', round(0.45), 'circle'),
  sunburst: card('sunburst', '#14110d', square, 'square'),
  engraved: card('engraved', '#4d16a8', dot, 'circle'),
  contour: card('contour', '#123527', round()),
  geometry: card('geometry', '#562c2c', round()),
  paper: card('paper', '#4d16a8', round()),
};

/** The link to encode. A preview needs the web origin from config, and ignores `url`. */
export type QrArtLink = LinkOptions &
  (
    | { preview: false; url: string; previewOrigin?: string }
    | { preview: true; previewOrigin: string; url?: string }
  );

const SIL = 69;
const SIL_MARGIN = 2;
const SIL_GAP = 2;
const BARE_QUIET = 4;
const NAIRA_HOLE = 5.5;

/** The cleared circle for the naira sign, off centre where a centre alignment pattern sits. */
function nairaSpot(grid: QrGrid): { a: number; b: number } {
  const n = grid.n;
  if (grid.version < 7) return { a: n / 2, b: n / 2 };
  // From version 7 an alignment pattern sits dead centre, and the patterns must stay: the mark
  // moves to the clear space between that one and the bottom-right one.
  const last = n - 7;
  const count = Math.floor(grid.version / 7) + 2;
  const step = Math.ceil((n - 13) / (2 * count - 2)) * 2;
  const spot = last - step / 2 + 0.5;
  return { a: spot, b: spot };
}

function coveredBy(
  recipe: Recipe,
  grid: QrGrid,
): (a: number, b: number) => boolean {
  if (recipe.type !== 'bare' || !recipe.naira) return () => false;
  const spot = nairaSpot(grid);
  return (a, b) =>
    !grid.reserved(a, b) &&
    Math.hypot(b + 0.5 - spot.b, a + 0.5 - spot.a) < NAIRA_HOLE;
}

/** The modules: data modules in the design's shape, function modules whole, finders styled. */
function codeBody(
  grid: QrGrid,
  recipe: { shape: Shape; finder: FinderStyle },
  paint: string,
  ink: string,
  covered: (a: number, b: number) => boolean,
): string {
  const n = grid.n;
  const on = (a: number, b: number) =>
    a >= 0 &&
    b >= 0 &&
    a < n &&
    b < n &&
    grid.dark(a, b) &&
    !grid.reserved(a, b) &&
    !covered(a, b);
  const draw = recipe.shape({ paint, on }, rng(3));
  const whole = square({ paint, on }, rng(3));
  let body = '';
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (on(a, b)) body += draw(a, b, paint);
      else if (grid.dark(a, b) && grid.reserved(a, b) && !inFinder(n, a, b))
        body += whole(a, b, paint);
    }
  return (
    body +
    finder(0, 0, ink, recipe.finder, 'br') +
    finder(n - 7, 0, paint, recipe.finder, 'bl') +
    finder(0, n - 7, paint, recipe.finder, 'tr')
  );
}

function bareSvg(recipe: BareRecipe, grid: QrGrid, size: number): string {
  const n = grid.n;
  const covered = coveredBy(recipe, grid);
  const paint = recipe.gradient ? 'url(#g)' : recipe.ink;
  const defs = recipe.gradient
    ? `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${n}" y2="${n}"><stop offset="0" stop-color="${recipe.gradient[0]}"/><stop offset="1" stop-color="${recipe.gradient[1]}"/></linearGradient></defs>`
    : '';
  let under = '';
  if (recipe.petals) {
    const r = rng(9);
    for (let i = 0; i < 70; i++)
      under += `<path transform="translate(${f(r() * (n + 8) - 4)} ${f(r() * (n + 8) - 4)}) rotate(${f(r() * 360)}) scale(${f(0.02 + r() * 0.04)}) translate(-733 -45)" d="${COVER_HEART}" fill="#ece2ff"/>`;
  }
  let mark = '';
  if (recipe.naira) {
    const { a, b } = nairaSpot(grid);
    const s = 0.078;
    mark = `<circle cx="${b}" cy="${a}" r="4.6" fill="#7a32f9"/><path transform="translate(${f(b - 50 * s)} ${f(a - 50 * s)}) scale(${s})" d="M26 82V18L74 82V18M10 42H90M10 58H90" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const code = codeBody(
    grid,
    recipe,
    paint,
    recipe.gradient?.[0] ?? recipe.ink,
    covered,
  );
  if (recipe.silhouette) {
    const off = Math.floor((SIL - n) / 2);
    const r = rng(17);
    let deco = '';
    for (let y = 0; y < SIL; y++)
      for (let x = 0; x < SIL; x++) {
        const a = y - off;
        const b = x - off;
        if (
          a >= -SIL_GAP &&
          b >= -SIL_GAP &&
          a < n + SIL_GAP &&
          b < n + SIL_GAP
        )
          continue;
        if (recipe.silhouette((x + 0.5) / SIL, (y + 0.5) / SIL) && r() < 0.52)
          deco += `<circle cx="${x + 0.5}" cy="${y + 0.5}" r=".42" fill="${recipe.ink}"/>`;
      }
    const view = SIL + SIL_MARGIN * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-SIL_MARGIN} ${-SIL_MARGIN} ${view} ${view}" width="${size}" height="${size}"><rect x="${-SIL_MARGIN}" y="${-SIL_MARGIN}" width="${view}" height="${view}" fill="#fff"/>${deco}<g transform="translate(${off} ${off})">${code}</g></svg>`;
  }
  const q = BARE_QUIET;
  const view = n + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-q} ${-q} ${view} ${view}" width="${size}" height="${size}">${defs}<rect x="${-q}" y="${-q}" width="${view}" height="${view}" fill="#fff"/>${under}${code}${mark}</svg>`;
}

const CARD_INSET = 0.02;
const CARD_QUIET = 2;

function cardGeometry(n: number) {
  const inner = CARD_PANEL.size - CARD_INSET * 2;
  const module = inner / (n + CARD_QUIET * 2);
  const start = CARD_PANEL.at + CARD_INSET + CARD_QUIET * module;
  return { module, start };
}

function cardSvg(recipe: CardRecipe, grid: QrGrid, size: number): string {
  const { module, start } = cardGeometry(grid.n);
  const code = codeBody(grid, recipe, recipe.ink, recipe.ink, () => false);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${size}" height="${size}"><g transform="translate(${start} ${start}) scale(${module})">${code}</g></svg>`;
}

// "Preview", drawn stroke by stroke so no font is involved.
const PREVIEW_LETTERS: readonly (readonly [string, number])[] = [
  ['M0 100V0H30C62 0 62 52 30 52H0', 52],
  ['M0 100V30M0 52C4 36 18 30 32 32', 32],
  [
    'M0 66H52C52 40 40 30 26 30C10 30 0 46 0 65C0 86 12 100 30 100C40 100 48 96 52 88',
    52,
  ],
  ['M0 30L24 100L48 30', 48],
  ['M0 100V30M0 8V9', 0],
  [
    'M0 66H52C52 40 40 30 26 30C10 30 0 46 0 65C0 86 12 100 30 100C40 100 48 96 52 88',
    52,
  ],
  ['M0 30L18 100L36 44L54 100L72 30', 72],
];

function previewMark(size: number): Buffer {
  const GAP = 22;
  let x = 0;
  let d = '';
  for (const [path, width] of PREVIEW_LETTERS) {
    d += `<path transform="translate(${x} 0)" d="${path}"/>`;
    x += width + GAP;
  }
  const wide = x - GAP;
  const scale = 0.82 / wide;
  return Buffer.from(
    // A pale edge under a dark core, so the mark shows on a dark photo as well as on white.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${size}" height="${size}"><g transform="rotate(-24 .5 .5) translate(.5 .5) scale(${scale}) translate(${f(-wide / 2)} -50)" fill="none" stroke-linecap="round" stroke-linejoin="round"><g opacity=".3" stroke="#fff" stroke-width="24">${d}</g><g opacity=".26" stroke="#000" stroke-width="14">${d}</g></g></svg>`,
  );
}

function recipeFor(id: string): Recipe {
  if (!Object.hasOwn(RECIPES, id)) throw new RangeError('Unknown QR design');
  return RECIPES[id as QrArtId];
}

interface LinkOptions {
  /** Permits plain http on this machine only, for local runs and tests. Never set in production. */
  allowLocalHttp?: boolean;
}

/** Every link is checked here, before the encoder, which is slow on long mixed text. */
function checkedLink(link: unknown, options: LinkOptions): URL {
  const refuse = () => new RangeError('A QR design needs a plain web link');
  if (
    typeof link !== 'string' ||
    link.length > MAX_URL_LENGTH ||
    // eslint-disable-next-line no-control-regex -- control characters are what it looks for
    /[\u0000-\u001f\u007f]/.test(link)
  )
    throw refuse();
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw refuse();
  }
  const localHttp =
    options.allowLocalHttp === true &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username ||
    parsed.password
  )
    throw refuse();
  return parsed;
}

function pageLink(url: unknown, options: LinkOptions): string {
  const parsed = checkedLink(url, options);
  // Encoded exactly as a browser would write it, so nothing odd is carried into the code.
  if (parsed.href !== url)
    throw new RangeError('A QR design needs a plain web link');
  return parsed.href;
}

/** A preview leads home on the origin it is told, and never looks at the page's own link. */
function encodedUrl(input: QrArtLink): string {
  if (!input.preview) return pageLink(input.url, input);
  const parsed = checkedLink(input.previewOrigin, input);
  if (parsed.origin !== input.previewOrigin)
    throw new RangeError('A QR preview needs the web origin');
  return `${parsed.origin}/?src=qr-preview`;
}

const ecOf = (recipe: Recipe) =>
  recipe.type === 'bare' ? recipe.ec : recipe.type === 'card' ? 'Q' : 'H';

/** Where a design puts its code on the image, in parts of the image's width. For tests of the code. */
export function qrArtLayout(input: QrArtLink & { id: string }) {
  const recipe = recipeFor(input.id);
  const grid = makeGrid(encodedUrl(input), ecOf(recipe));
  const n = grid.n;
  let module: number;
  let start: number;
  if (recipe.type === 'card') {
    ({ module, start } = cardGeometry(n));
  } else if (recipe.type === 'mosaic') {
    module = 1 / (n + MOSAIC_QUIET * 2);
    start = MOSAIC_QUIET * module;
  } else if (recipe.silhouette) {
    module = 1 / (SIL + SIL_MARGIN * 2);
    start = (Math.floor((SIL - n) / 2) + SIL_MARGIN) * module;
  } else {
    module = 1 / (n + BARE_QUIET * 2);
    start = BARE_QUIET * module;
  }
  return {
    modules: n,
    module,
    left: start,
    top: start,
    dark: grid.dark,
    reserved: grid.reserved,
    covered: coveredBy(recipe, grid),
  };
}

/**
 * How a link would sit in the mosaic. From version 7 extra alignment patterns land on the face.
 * Advice for the route: nothing here refuses a link, because the policy is the owner's to choose.
 */
export function qrMosaicFit(url: string, options: LinkOptions = {}) {
  const { version, n } = makeGrid(pageLink(url, options), ecOf(RECIPES.mosaic));
  return {
    version,
    modules: n,
    alignmentOnFace: n >= MOSAIC_FACE_ALIGNMENT_MODULES,
  };
}

/** One QR design as a PNG of `size` pixels, carrying no metadata. */
export async function renderQrArt(
  input: QrArtLink & { id: string; photo?: Buffer; size: number },
): Promise<Buffer> {
  const { id, photo, preview, size } = input;
  const recipe = recipeFor(id);
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE)
    throw new RangeError('QR size out of range');
  const grid = makeGrid(encodedUrl(input), ecOf(recipe));
  const overlays: OverlayOptions[] = [];
  let image: Sharp;
  if (recipe.type === 'mosaic') {
    image = await drawMosaic(grid, photo, size);
  } else if (recipe.type === 'card') {
    image = sharp(await cardFrame(recipe.cover)).resize(size, size);
    overlays.push({ input: Buffer.from(cardSvg(recipe, grid, size)) });
  } else {
    image = sharp(Buffer.from(bareSvg(recipe, grid, size)));
  }
  if (preview) overlays.push({ input: previewMark(size) });
  if (overlays.length) image = image.composite(overlays);
  // Written out from the pixels alone: sharp keeps no input metadata unless asked to.
  return image
    .timeout({ seconds: 10 })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 6 })
    .toBuffer();
}
