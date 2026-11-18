import {
  COVER_RENDITION_WIDTHS,
  type CoverRenditionWidth,
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

export interface CoverRendition {
  width: CoverRenditionWidth;
  webp: Buffer;
}

/**
 * The cover at each of `COVER_RENDITION_WIDTHS` narrower than itself, same shape, from the stored
 * WebP (already re-encoded and metadata-free, so these carry none either). Never upscaled: a width
 * at or above the cover's own is skipped. The caller holds a re-encoding slot (`withSlot`).
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
      width: target,
      webp: await sharp(cover)
        .timeout({ seconds: 5 })
        .resize(target, Math.round((target * height) / width), { fit: 'fill' })
        .webp({ quality: RENDITION_QUALITY })
        .toBuffer(),
    });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A rendition's address (`<uuid>/<n>-<width>.webp`): its version and width, or null if it isn't
 * one of `COVER_RENDITION_WIDTHS` (so any other width is simply not found).
 */
export function renditionFile(
  profileId: string,
  file: string,
): { version: number; width: CoverRenditionWidth } | null {
  const m = /^(\d{1,9})-(\d{3,4})\.webp$/.exec(file);
  if (!m || !UUID.test(profileId)) return null;
  const width = COVER_RENDITION_WIDTHS.find((w) => String(w) === m[2]);
  return width ? { version: Number(m[1]), width } : null;
}
