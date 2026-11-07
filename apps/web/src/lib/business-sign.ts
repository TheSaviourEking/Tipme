import {
  isScannableStyle,
  qrMatrix,
  QR_STYLES,
  renderQrPixels,
  type QrStyle,
} from './qr-render.ts';

/**
 * PR B8: the printed location sign and staff badge, drawn on a canvas with today's QR rendering
 * (`qrMatrix` / `renderQrPixels`, as `drawQrCard` does). The code is always dark modules on a light
 * square with a quiet zone, so it scans in every style offered here.
 */

/** Only the TipMe black and purple styles, and only if they scan. Black is the board's dark card. */
export const SIGN_STYLES: readonly QrStyle[] = ['night', 'purple']
  .map((id) => QR_STYLES.find((style) => style.id === id))
  .filter(
    (style): style is QrStyle => style !== undefined && isScannableStyle(style),
  );

export const SIGN_FORMATS = [
  { id: 'sign', name: 'Location sign', size: 'Prints on A5' },
  { id: 'tent', name: 'Table tent', size: 'Prints on A6' },
  { id: 'badge', name: 'Staff badge', size: 'Prints 85 × 55 mm' },
] as const;
export type SignFormatId = (typeof SIGN_FORMATS)[number]['id'];

/** What the code encodes: the web's own origin (as `/dashboard/qr` does) and the API's path. */
export const codeUrl = (origin: string, path: string): string =>
  `${origin}${path}`;

/** The link printed under a code: no scheme and no `?src=qr` tag. */
export const printedLink = (url: string): string =>
  url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');

type Ctx = CanvasRenderingContext2D;
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'Arial, sans-serif';

/**
 * Draws one line centred on `x` in the largest size from `size` down to 60% of it that fits
 * `maxWidth`, then cuts it with an ellipsis: a long business name never runs off the card.
 */
function fitText(
  ctx: Ctx,
  text: string,
  {
    x,
    y,
    maxWidth,
    size,
    weight,
    family,
  }: {
    x: number;
    y: number;
    maxWidth: number;
    size: number;
    weight: number;
    family: string;
  },
): void {
  const fontAt = (px: number) => `${weight} ${Math.round(px)}px ${family}`;
  let px = size;
  ctx.font = fontAt(px);
  while (ctx.measureText(text).width > maxWidth && px > size * 0.6) {
    px -= Math.max(1, size * 0.04);
    ctx.font = fontAt(px);
  }
  let line = text;
  while (ctx.measureText(line).width > maxWidth && line.length > 1)
    line = `${Array.from(line).slice(0, -2).join('').trimEnd()}…`;
  ctx.fillText(line, x, y);
}

/** The code on its rounded light plate, `box` pixels wide at most, top-left at (x, y). */
function drawCode(
  ctx: Ctx,
  url: string,
  style: QrStyle,
  { x, y, box }: { x: number; y: number; box: number },
): number {
  const matrix = qrMatrix(url);
  const pad = Math.round(box * 0.04);
  const scale = Math.max(2, Math.floor((box - pad * 2) / (matrix.size + 8)));
  const pixels = renderQrPixels(matrix, style, { scale });
  const left = Math.round(x + (box - pixels.width) / 2);
  ctx.fillStyle = style.light;
  ctx.beginPath();
  ctx.roundRect(
    left - pad,
    y - pad,
    pixels.width + pad * 2,
    pixels.width + pad * 2,
    box * 0.05,
  );
  ctx.fill();
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.data),
      pixels.width,
      pixels.width,
    ),
    left,
    y,
  );
  return pixels.width + pad;
}

function frame(ctx: Ctx, style: QrStyle, width: number, height: number) {
  ctx.fillStyle = style.frame.color;
  ctx.fillRect(0, 0, width, height);
}

/**
 * The location sign (board section 1): the dark card, the business's initial, its name, the
 * location, the code, "Scan to thank our team", and the link in text under it. Portrait A5/A6
 * proportions; `width` in pixels.
 */
export function drawLocationSign(
  canvas: HTMLCanvasElement,
  input: {
    url: string;
    business: string;
    location: string;
    style: QrStyle;
    width: number;
  },
): void {
  const { style, width } = input;
  const height = Math.round((width * 210) / 148);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  frame(ctx, style, width, height);
  const centre = width / 2;
  const maxWidth = width * 0.86;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // The initial on a tile in the text colour, like the logo on the board.
  const tile = Math.round(width * 0.13);
  const tileTop = Math.round(height * 0.08);
  ctx.fillStyle = style.frameText;
  ctx.beginPath();
  ctx.roundRect(centre - tile / 2, tileTop, tile, tile, tile * 0.27);
  ctx.fill();
  ctx.fillStyle = style.frame.color;
  ctx.font = `400 ${Math.round(tile * 0.55)}px ${SERIF}`;
  const initial = Array.from(input.business.trim())[0]?.toUpperCase() ?? '';
  ctx.fillText(initial, centre, tileTop + tile * 0.7);

  ctx.fillStyle = style.frameText;
  fitText(ctx, input.business, {
    x: centre,
    y: tileTop + tile + height * 0.075,
    maxWidth,
    size: width * 0.085,
    weight: 400,
    family: SERIF,
  });
  fitText(ctx, input.location, {
    x: centre,
    y: tileTop + tile + height * 0.125,
    maxWidth,
    size: width * 0.045,
    weight: 600,
    family: SANS,
  });

  const box = Math.round(width * 0.62);
  const codeTop = Math.round(tileTop + tile + height * 0.165);
  const drawn = drawCode(ctx, input.url, style, {
    x: (width - box) / 2,
    y: codeTop,
    box,
  });
  ctx.fillStyle = style.frameText;
  fitText(ctx, 'Scan to thank our team', {
    x: centre,
    y: codeTop + drawn + height * 0.08,
    maxWidth,
    size: width * 0.06,
    weight: 700,
    family: SANS,
  });
  fitText(ctx, printedLink(input.url), {
    x: centre,
    y: codeTop + drawn + height * 0.125,
    maxWidth,
    size: width * 0.035,
    weight: 400,
    family: SANS,
  });
}

/** A staff badge (85 × 55 mm): the person's name, "at {business}", and their code on the right. */
export function drawStaffBadge(
  canvas: HTMLCanvasElement,
  input: {
    url: string;
    name: string;
    business: string;
    style: QrStyle;
    width: number;
  },
): void {
  const { style, width } = input;
  const height = Math.round((width * 55) / 85);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  frame(ctx, style, width, height);
  const box = Math.round(height * 0.82);
  const codeTop = Math.round((height - box) / 2);
  drawCode(ctx, input.url, style, {
    x: width - box - height * 0.08,
    y: codeTop + Math.round(box * 0.04),
    box,
  });
  const textWidth = width - box - height * 0.24;
  const left = height * 0.1;
  ctx.fillStyle = style.frameText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // The text is centred in the column left of the code.
  const column = left + textWidth / 2;
  fitText(ctx, input.name, {
    x: column,
    y: height * 0.45,
    maxWidth: textWidth,
    size: height * 0.17,
    weight: 400,
    family: SERIF,
  });
  fitText(ctx, `at ${input.business}`, {
    x: column,
    y: height * 0.58,
    maxWidth: textWidth,
    size: height * 0.075,
    weight: 600,
    family: SANS,
  });
  fitText(ctx, 'Scan to thank me', {
    x: column,
    y: height * 0.78,
    maxWidth: textWidth,
    size: height * 0.065,
    weight: 700,
    family: SANS,
  });
}
