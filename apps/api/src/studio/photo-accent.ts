import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  hexToOklch,
  pickPhotoAccent,
  type Hex,
  type PhotoAccentFailed,
  type PhotoAccentValues,
} from '@tipme/contracts';
import {
  clearPhotoAccent,
  featureOn,
  setPhotoAccent,
  studioPhotoSource,
  type PhotoStore,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import sharp from 'sharp';
import { DatabaseProvider } from '../infra/database.js';
import { hasImageSignature, withSlot } from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { LOGGER } from '../tokens.js';

// "From your photo" (styles spec §6): up to five dominant colours from the stored profile photo,
// turned into an accent by `pickPhotoAccent` (contracts). Computed on the server when the person
// picks it and every time the photo changes; the public page uses the stored value. A photo
// change never fails because of it: any failure here leaves the page on the style's own accent.

/** §6 step 1: the 128 px rendition. */
const SIZE = 128;
/** Our stored photo is 512 × 512; anything much larger is not ours and is not decoded. */
const MAX_INPUT_PIXELS = 1024 * 1024;
/** Bounded in time as uploads are; sharp stops the work, not only the wait. */
const TIMEOUT_SECONDS = 2;
/** 4 bits a channel: 4,096 colour boxes, so near shades count as one colour. */
const BITS = 4;
/** A colour must cover at least 1% of the photo to be dominant (noise and edges are not). */
const MIN_SHARE = 0.01;
/** Colours closer than this in OKLab are the same colour for this purpose. */
const DISTINCT = 0.08;
const MAX_COLOURS = 5;

type Lab = [number, number, number];
const lab = (h: Hex): Lab => {
  const { l, c, h: hue } = hexToOklch(h);
  const r = (hue * Math.PI) / 180;
  return [l, c * Math.cos(r), c * Math.sin(r)];
};
const hexOf = (r: number, g: number, b: number): Hex =>
  `#${[r, g, b]
    .map((v) =>
      Math.min(255, Math.max(0, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/**
 * Up to five dominant colours of a stored profile photo, most dominant first. Deterministic: the
 * photo is scaled to 128 × 128 (16,384 pixels, about 48 KB of memory), every pixel is counted into
 * a fixed colour box, the boxes are ordered by count and then by their index, and each colour is
 * its box's mean. No randomness, no clustering that depends on a starting point.
 */
export async function sampleAvatarColours(webp: Buffer): Promise<Hex[]> {
  if (!hasImageSignature(webp)) throw new Error('not an image');
  const { data, info } = await sharp(webp, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
  })
    .timeout({ seconds: TIMEOUT_SECONDS })
    .resize(SIZE, SIZE, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const boxes = 1 << (BITS * 3);
  const count = new Uint32Array(boxes);
  const sums = new Float64Array(boxes * 3);
  const shift = 8 - BITS;
  const pixels = data.length / channels;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const box =
      ((r >> shift) << (BITS * 2)) | ((g >> shift) << BITS) | (b >> shift);
    count[box]! += 1;
    sums[box * 3]! += r;
    sums[box * 3 + 1]! += g;
    sums[box * 3 + 2]! += b;
  }
  const order = [...count.keys()]
    .filter((box) => count[box]! >= pixels * MIN_SHARE)
    .sort((a, b) => count[b]! - count[a]! || a - b);
  const chosen: { hex: Hex; lab: Lab }[] = [];
  for (const box of order) {
    const n = count[box]!;
    const hex = hexOf(
      sums[box * 3]! / n,
      sums[box * 3 + 1]! / n,
      sums[box * 3 + 2]! / n,
    );
    const own = lab(hex);
    if (
      chosen.some(
        (c) =>
          Math.hypot(own[0] - c.lab[0], own[1] - c.lab[1], own[2] - c.lab[2]) <
          DISTINCT,
      )
    )
      continue;
    chosen.push({ hex, lab: own });
    if (chosen.length === MAX_COLOURS) break;
  }
  // Every value is a six-digit hex this code wrote: no input text ever reaches the result.
  return chosen.map((c) => c.hex);
}

/**
 * The photo accent for a stored profile photo: its values, the curated fallback when no colour
 * passes, or null when the photo could not be sampled. Never throws; a failure is logged with
 * the page id alone (no name, handle or error text).
 */
export async function photoAccentFor(
  webp: Buffer,
  options: {
    sample?: (webp: Buffer) => Promise<Hex[]>;
    log?: Pick<Logger, 'warn'> | null;
    profileId?: string;
  } = {},
): Promise<PhotoAccentValues | PhotoAccentFailed | null> {
  try {
    const colours = await (options.sample ?? sampleAvatarColours)(webp);
    return pickPhotoAccent(colours);
  } catch {
    options.log?.warn({
      event: 'studio.photo_accent_failed',
      profileId: options.profileId,
    });
    return null;
  }
}

/**
 * Keeps the stored photo accent in step with the profile photo. Only while Page Studio is on (the
 * `page_studio` switch), and only for a page with a Studio row. Never throws: the caller's change
 * (an upload, a removal, a save) has already succeeded and must stay so.
 */
@Injectable()
export class StudioPhotoAccent {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
    @Optional()
    @Inject(LOGGER)
    private readonly logger: Pick<Logger, 'warn'> | null = null,
  ) {}

  /** After the photo changed or a save picked "From your photo": recompute, or clear. */
  async refresh(userId: string): Promise<void> {
    const db = this.database.db;
    let profileId: string | undefined;
    try {
      if (!(await featureOn(db, 'page_studio'))) return;
      const source = await studioPhotoSource(
        db,
        userId,
        this.photos ?? undefined,
      );
      if (!source) {
        await clearPhotoAccent(db, userId);
        return;
      }
      profileId = source.profileId;
      const accent = await withSlot(() =>
        photoAccentFor(source.webp, {
          log: this.logger,
          profileId: source.profileId,
        }),
      );
      // Not sampled: nothing is stored, and the value for the older photo is never read again
      // (`photoAccentOf` checks the photo's version), so the page shows the style's own accent.
      if (!accent) return;
      await setPhotoAccent(
        db,
        source.profileId,
        source.avatarVersion,
        'failed' in accent
          ? accent
          : {
              source: 'avatar',
              avatarVersion: source.avatarVersion,
              ...accent,
            },
      );
    } catch {
      this.logger?.warn({ event: 'studio.photo_accent_failed', profileId });
    }
  }
}
