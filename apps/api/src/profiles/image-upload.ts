import type { Request, Response } from 'express';
import sharp from 'sharp';
import { CodedHttpException } from '../http/coded.exception.js';

// What page photos and covers share. An upload is never stored as sent: it is decoded and
// re-encoded here to a WebP of a fixed size, which drops all metadata (EXIF location, camera
// details). Only real JPEG, PNG and WebP photos are accepted; SVG never (it can carry script).

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Refuses "pixel bombs": small files that decode to enormous images. 25 MP covers any phone
// photo, and the browser shrinks photos before sending them anyway.
const MAX_INPUT_PIXELS = 25_000_000;
// At most this many images are re-encoded or drawn at once in one API process: photos, covers
// and QR designs together. Decoding runs on the thread pool every request shares, so a burst
// must not slow everything else.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
export async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

sharp.cache(false);

/**
 * Whether the bytes start like a JPEG, PNG or WebP. Checked before the decoder sees them: otherwise
 * sharp's other loaders (SVG, TIFF, GIF) parse whatever arrives, outside the re-encoding timeout,
 * while holding a slot. The decoder still decides whether it's a real image.
 */
export function hasImageSignature(bytes: Buffer): boolean {
  const starts = (signature: number[], at = 0) =>
    signature.every((byte, i) => bytes[at + i] === byte);
  return (
    starts([0xff, 0xd8, 0xff]) ||
    starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
  );
}

/** The request body, read here (no parser handles images), refused past `MAX_BYTES`. */
export async function readUpload(request: Request): Promise<Buffer> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (!ACCEPTED.has(type)) throw new CodedHttpException(415, 'INVALID_IMAGE');
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BYTES)
    throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BYTES)
      throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!hasImageSignature(body))
    throw new CodedHttpException(400, 'INVALID_IMAGE');
  return body;
}

/**
 * Decodes and re-encodes to a WebP of exactly this size; anything that is not a decodable
 * JPEG/PNG/WebP is INVALID_IMAGE.
 */
export function reencodeTo(width: number, height: number) {
  return async (input: Buffer): Promise<Buffer> => {
    try {
      // failOn 'error' (not sharp's stricter 'warning') accepts phone photos with harmless
      // quirks; it is safe because every upload is re-encoded, never stored as sent.
      const image = sharp(input, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
      }).timeout({ seconds: 5 });
      const { format } = await image.metadata();
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp')
        throw new Error('unsupported format');
      return await image
        .rotate() // honour the camera's orientation before the metadata is dropped
        .resize(width, height, { fit: 'cover' })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new CodedHttpException(400, 'INVALID_IMAGE');
    }
  };
}

/** The version in a served image's address (`<uuid>/<n>.webp`), or null if it isn't one. */
export function imageVersion(profileId: string, file: string): number | null {
  const version = /^(\d{1,9})\.webp$/.exec(file)?.[1];
  return UUID.test(profileId) && version ? Number(version) : null;
}

/**
 * A version's URL is never reused (a new image is a new version), so it caches, but for an hour
 * only: a hidden page's image should not linger.
 */
export function sendImage(response: Response, bytes: Buffer | null): void {
  if (!bytes) throw new CodedHttpException(404, 'NOT_FOUND');
  response
    .status(200)
    .setHeader('Content-Type', 'image/webp')
    .setHeader('Cache-Control', 'public, max-age=3600, immutable')
    .setHeader('Content-Security-Policy', "default-src 'none'")
    .end(bytes);
}

/** An image only its owner or staff may see, whatever the page's state: never stored by a cache. */
export function sendPrivateImage(
  response: Response,
  bytes: Buffer | null,
): void {
  if (!bytes) throw new CodedHttpException(404, 'NOT_FOUND');
  response
    .status(200)
    .setHeader('Content-Type', 'image/webp')
    .setHeader('Cache-Control', 'private, no-store')
    .setHeader('Content-Security-Policy', "default-src 'none'")
    .end(bytes);
}
