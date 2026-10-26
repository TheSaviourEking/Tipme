/**
 * Profile photos (PRD FR-01). The browser re-encodes a chosen photo to WebP; the server accepts
 * only a plain WebP: image data chunks, no metadata (EXIF/XMP, where GPS lives), no animation,
 * bounded in bytes and pixels. Browsers always attach an sRGB colour profile when encoding, so
 * that one chunk is removed rather than refused. The original upload is never stored.
 */
export const AVATAR_MAX_BYTES = 400_000;
export const AVATAR_MAX_SIDE = 1600;

const ALLOWED = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);
const ICC_FLAG = 0x20;
// VP8X flags that must be off: EXIF, XMP, animation.
const FORBIDDEN_FLAGS = 0x08 | 0x04 | 0x02;

const fourcc = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u24 = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

/**
 * The photo's size and the bytes to store (any colour profile removed) when it is an acceptable
 * plain WebP, otherwise null.
 */
export function inspectAvatar(
  bytes: Uint8Array,
): { width: number; height: number; bytes: Uint8Array } | null {
  if (bytes.length < 20 || bytes.length > AVATAR_MAX_BYTES) return null;
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') return null;
  if (u32(bytes, 4) + 8 !== bytes.length) return null;
  let size: { width: number; height: number } | null = null;
  const kept: Uint8Array[] = [];
  let at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return null;
    const id = fourcc(bytes, at);
    const length = u32(bytes, at + 4);
    const data = at + 8;
    const next = data + length + (length % 2);
    if (data + length > bytes.length) return null;
    if (id === 'ICCP') {
      at = next;
      continue;
    }
    if (!ALLOWED.has(id)) return null;
    const stored = bytes.slice(at, Math.min(next, bytes.length));
    kept.push(stored);
    if (id === 'VP8X') {
      if (length < 10 || (bytes[data]! & FORBIDDEN_FLAGS) !== 0) return null;
      stored[8] = stored[8]! & ~ICC_FLAG;
      size = {
        width: u24(bytes, data + 4) + 1,
        height: u24(bytes, data + 7) + 1,
      };
    } else if (id === 'VP8 ' && !size) {
      if (
        length < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      )
        return null;
      size = {
        width: (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff,
        height: (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff,
      };
    } else if (id === 'VP8L' && !size) {
      if (length < 5 || bytes[data] !== 0x2f) return null;
      const bits = u32(bytes, data + 1);
      size = {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    at = next;
  }
  if (!size || size.width < 1 || size.height < 1) return null;
  if (size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE)
    return null;
  const body = kept.reduce((total, chunk) => total + chunk.length, 4);
  const clean = new Uint8Array(8 + body);
  clean.set(bytes.subarray(0, 4));
  new DataView(clean.buffer).setUint32(4, body, true);
  clean.set(bytes.subarray(8, 12), 8);
  let offset = 12;
  for (const chunk of kept) {
    clean.set(chunk, offset);
    offset += chunk.length;
  }
  return { ...size, bytes: clean };
}
