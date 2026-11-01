import sharp, { type Sharp } from 'sharp';
import { hasImageSignature } from '../profiles/image-upload.js';
import type { QrGrid } from './render.js';

// The photo mosaic: each module is seven sub-cells across, the centre three forced to the code's
// dark or light and the ring around them left as the picture. Function modules and the quiet zone
// aren't the picture at all, because a reader finds the code by them.

const MAX_PHOTO_PIXELS = 25_000_000;
const SUB = 7;
const CENTRE = [2, 3, 4];
const INK = [28, 20, 16] as const;
/** How far a forced centre is pulled toward black, or toward white, from the photo's own colour. */
const DARK_KEEP = 0.22;
const LIGHT_KEEP = 0.14;
export const MOSAIC_QUIET = 4;

/** Thrown when the mosaic has no usable photo: the page has none, or it isn't an image. */
export class QrArtPhotoRequiredError extends Error {
  constructor() {
    super('The photo mosaic needs a photo');
    this.name = 'QrArtPhotoRequiredError';
  }
}

/** Thrown when the photo is an image, but too many pixels to decode: told apart from having none. */
export class QrArtPhotoTooLargeError extends Error {
  constructor() {
    super('The photo is too large for the mosaic');
    this.name = 'QrArtPhotoTooLargeError';
  }
}

/** The mosaic as an opaque image of `size` pixels, carrying none of the photo's metadata. */
export async function drawMosaic(
  grid: QrGrid,
  photo: Buffer | undefined,
  size: number,
): Promise<Sharp> {
  if (!photo || !hasImageSignature(photo)) throw new QrArtPhotoRequiredError();
  const cells = grid.n + MOSAIC_QUIET * 2;
  const across = cells * SUB;
  let picture: Buffer;
  try {
    // Read from the header alone, so an oversized photo is named before anything is decoded.
    const { width, height } = await sharp(photo, {
      limitInputPixels: false,
    }).metadata();
    if (width * height > MAX_PHOTO_PIXELS) throw new QrArtPhotoTooLargeError();
    picture = await sharp(photo, {
      limitInputPixels: MAX_PHOTO_PIXELS,
      failOn: 'error',
    })
      .timeout({ seconds: 5 })
      .flatten({ background: '#ffffff' })
      .resize(across, across, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch (error) {
    if (error instanceof QrArtPhotoTooLargeError) throw error;
    throw new QrArtPhotoRequiredError();
  }
  const out = Buffer.alloc(across * across * 3, 255);
  for (let y = 0; y < across; y++)
    for (let x = 0; x < across; x++) {
      const a = Math.floor(y / SUB) - MOSAIC_QUIET;
      const b = Math.floor(x / SUB) - MOSAIC_QUIET;
      if (a < 0 || b < 0 || a >= grid.n || b >= grid.n) continue;
      const at = (y * across + x) * 3;
      const on = grid.dark(a, b);
      if (grid.reserved(a, b)) {
        for (let c = 0; c < 3; c++) out[at + c] = on ? INK[c]! : 255;
        continue;
      }
      const centre = CENTRE.includes(y % SUB) && CENTRE.includes(x % SUB);
      for (let c = 0; c < 3; c++) {
        const v = picture[at + c]!;
        out[at + c] = !centre
          ? v
          : on
            ? v * DARK_KEEP
            : 255 - (255 - v) * LIGHT_KEEP;
      }
    }
  return sharp(out, {
    raw: { width: across, height: across, channels: 3 },
  }).resize(size, size, { kernel: size > across ? 'nearest' : 'lanczos3' });
}
