import {
  STUDIO_IMAGE_ASPECT,
  STUDIO_IMAGE_SHAPES,
  STUDIO_IMAGE_WIDTHS,
} from '@tipme/contracts';
import sharp from 'sharp';
import { CodedHttpException } from '../http/coded.exception.js';
import { hasImageSignature } from '../profiles/image-upload.js';

// Page Studio photos (plan Task 7). An upload is decoded and re-encoded here, never stored as
// sent: the master is the upright photo fitted inside 2400px, and every rendition is cut from it
// around the person's focal point. All metadata (EXIF location, camera details) is dropped.
// The same safeguards as page photos: a pixel limit, a timeout, and JPEG/PNG/WebP only.

const MAX_INPUT_PIXELS = 25_000_000;
const MASTER_MAX = 2400;
/** Shorter than this, a photo can't look sharp in a Studio row; refused plainly. */
export const STUDIO_MIN_SIDE = 600;

export interface StudioMaster {
  master: Buffer;
  width: number;
  height: number;
}

/** The upright photo as a WebP inside 2400×2400; IMAGE_TOO_SMALL under 600px on its short side. */
export async function masterOf(input: Buffer): Promise<StudioMaster> {
  if (!hasImageSignature(input))
    throw new CodedHttpException(400, 'INVALID_IMAGE');
  let master: { data: Buffer; info: { width: number; height: number } };
  try {
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    }).timeout({ seconds: 5 });
    const { format } = await image.metadata();
    if (format !== 'jpeg' && format !== 'png' && format !== 'webp')
      throw new Error('unsupported format');
    master = await image
      .rotate() // the camera's orientation, before the metadata is dropped
      .resize(MASTER_MAX, MASTER_MAX, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new CodedHttpException(400, 'INVALID_IMAGE');
  }
  const { width, height } = master.info;
  if (Math.min(width, height) < STUDIO_MIN_SIDE)
    throw new CodedHttpException(422, 'IMAGE_TOO_SMALL');
  return { master: master.data, width, height };
}

/**
 * The largest rectangle of this aspect (width ÷ height) inside the photo, centred on the focal
 * point (percentages across and down) as far as the edges allow.
 */
export function cropBox(
  width: number,
  height: number,
  aspect: number,
  focalX: number,
  focalY: number,
): { left: number; top: number; width: number; height: number } {
  const w = Math.floor(Math.min(width, height * aspect));
  const h = Math.floor(w / aspect);
  const clamp = (v: number, max: number) =>
    Math.min(Math.max(0, Math.round(v)), max);
  return {
    left: clamp((focalX / 100) * width - w / 2, width - w),
    top: clamp((focalY / 100) * height - h / 2, height - h),
    width: w,
    height: h,
  };
}

/**
 * Every shape at 480, 960 and 1440 wide, named `<shape>-<width>`. A width wider than the shape's
 * crop is not made (never upscaled); 480 always is, because a master is at least 600px.
 */
export async function renditionsOf(
  master: Buffer,
  focalX: number,
  focalY: number,
): Promise<Record<string, Buffer>> {
  const { width = 0, height = 0 } = await sharp(master).metadata();
  const files: Record<string, Buffer> = {};
  for (const shape of STUDIO_IMAGE_SHAPES) {
    const box = cropBox(
      width,
      height,
      STUDIO_IMAGE_ASPECT[shape],
      focalX,
      focalY,
    );
    for (const target of STUDIO_IMAGE_WIDTHS) {
      if (target > box.width && target !== STUDIO_IMAGE_WIDTHS[0]) continue;
      files[`${shape}-${target}`] = await sharp(master)
        .extract(box)
        .resize(target, Math.round(target / STUDIO_IMAGE_ASPECT[shape]), {
          fit: 'fill',
        })
        .webp({ quality: 80 })
        .toBuffer();
    }
  }
  return files;
}
