import {
  COVER_RENDITION_WIDTHS,
  COVER_TALL_WIDTHS,
  type CoverRenditionWidth,
  type CoverTallWidth,
} from '@tipme/contracts';
import sharp from 'sharp';
import { reencodeTo } from './image-upload.js';

// Page covers: 2240×600, twice the widest the standard page shows. The safeguards every upload
// gets are in image-upload.ts.
export const toCover = reencodeTo(2240, 600);

/**
 * Quality for the smaller copies. Lower than the full cover's 80: at these sizes the difference
 * is not visible, and the 640 copy is the largest paint on a phone in the Studio styles Stage and
 * Horizon (spec 2026-11-17 §9.9: under 2 s at 4× CPU on Fast 3G). Measured on a generated photo:
 * apps/api/test/cover-renditions.test.mjs prints the sizes.
 */
const RENDITION_QUALITY = 75;

/** The rendition step, injectable so a test can make it fail (cover.controller.ts). */
export const COVER_RENDITIONS = Symbol('COVER_RENDITIONS');

export type CoverRendition =
  | { shape: 'wide'; width: CoverRenditionWidth; webp: Buffer }
  | { shape: 'tall'; width: CoverTallWidth; webp: Buffer };

/**
 * The tall crop's region of a source: what the phone hero of Stage and Horizon already shows with
 * `object-fit: cover; object-position: 50% 33%` in a 4:5 box (about 390×488 CSS px). As large as
 * fits at 4:5, so a band wider than that keeps its full height (a 2240×600 cover: 480×600 at x=880),
 * and an image taller than that keeps its full width. The offsets follow object-position: the spare
 * width × 50%, the spare height × 33%.
 */
export function tallCropRegion(
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const w = Math.min(width, Math.round(height * 0.8));
  const h = Math.min(height, Math.round(w * 1.25));
  return {
    left: Math.round((width - w) * 0.5),
    top: Math.round((height - h) * 0.33),
    width: w,
    height: h,
  };
}

/** The tall widths a crop this wide can give without upscaling (a width wider is skipped). */
export const tallCropWidths = (cropWidth: number): CoverTallWidth[] =>
  COVER_TALL_WIDTHS.filter((w) => w <= cropWidth);

/**
 * The cover at each of `COVER_RENDITION_WIDTHS` narrower than itself, same shape, and its tall crop
 * (`tallCropRegion`) at each of `tallCropWidths`, from the stored WebP (already re-encoded and
 * metadata-free, so these carry none either). Never upscaled: a width at or above the cover's own,
 * or wider than the crop, is skipped. The caller holds a re-encoding slot (`withSlot`).
 */
export async function coverRenditionsOf(
  cover: Buffer,
): Promise<CoverRendition[]> {
  const image = sharp(cover, { failOn: 'error' }).timeout({ seconds: 5 });
  const { width = 0, height = 0, format } = await image.metadata();
  if (format !== 'webp' || !width || !height)
    throw new Error('not a stored cover');
  const out: CoverRendition[] = [];
  for (const target of COVER_RENDITION_WIDTHS) {
    if (target >= width) continue;
    out.push({
      shape: 'wide',
      width: target,
      webp: await sharp(cover)
        .timeout({ seconds: 5 })
        .resize(target, Math.round((target * height) / width), { fit: 'fill' })
        .webp({ quality: RENDITION_QUALITY })
        .toBuffer(),
    });
  }
  const region = tallCropRegion(width, height);
  for (const target of tallCropWidths(region.width)) {
    // At the crop's own width this is a cut alone, no resampling: the very pixels shown today.
    const crop = sharp(cover).timeout({ seconds: 5 }).extract(region);
    out.push({
      shape: 'tall',
      width: target,
      webp: await (
        target === region.width
          ? crop
          : crop.resize(target, Math.round(target * 1.25), { fit: 'fill' })
      )
        .webp({ quality: RENDITION_QUALITY })
        .toBuffer(),
    });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A rendition's address (`<uuid>/<n>-<width>.webp`, or `<uuid>/<n>-tall-<width>.webp` for a tall
 * crop): its version, shape and width, or null if the width isn't one of that shape's
 * (`COVER_RENDITION_WIDTHS`, `COVER_TALL_WIDTHS`), so any other width is simply not found.
 */
export function renditionFile(
  profileId: string,
  file: string,
):
  | { version: number; shape: 'wide'; width: CoverRenditionWidth }
  | { version: number; shape: 'tall'; width: CoverTallWidth }
  | null {
  const m = /^(\d{1,9})-(tall-)?(\d{3,4})\.webp$/.exec(file);
  if (!m || !UUID.test(profileId)) return null;
  const version = Number(m[1]);
  if (m[2]) {
    const width = COVER_TALL_WIDTHS.find((w) => String(w) === m[3]);
    return width ? { version, shape: 'tall', width } : null;
  }
  const width = COVER_RENDITION_WIDTHS.find((w) => String(w) === m[3]);
  return width ? { version, shape: 'wide', width } : null;
}
