import { brotliDecompressSync } from 'node:zlib';

/**
 * The characters a TrueType font draws, read from its `cmap` table (format 12, else format 4).
 * Satori picks a fallback font word by word and drops the space after a fallback word, so a share
 * card sets a name in one font that draws all of it instead (see `setsIn`).
 */
export function characterMap(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let cmap = -1;
  let length = 0;
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(record, record + 4));
    if (tag === 'cmap') {
      cmap = view.getUint32(record + 8);
      length = view.getUint32(record + 12);
    }
  }
  if (cmap < 0) throw new Error('font has no cmap table');
  return cmapOf(font.subarray(cmap, cmap + length));
}

/** The characters a `cmap` table maps to a glyph (format 12, else format 4). */
export function cmapOf(table: Uint8Array): Set<number> {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const cmap = 0;
  let format4 = -1;
  let format12 = -1;
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i += 1) {
    const record = cmap + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && encoding !== 0);
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    if (format === 4) format4 = offset;
  }

  const covered = new Set<number>();
  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12);
    for (let i = 0; i < groups; i += 1) {
      const group = format12 + 16 + i * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      for (let c = start; c <= end; c += 1)
        if (glyph + (c - start) !== 0) covered.add(c);
    }
    return covered;
  }
  if (format4 < 0) throw new Error('font has no Unicode cmap');
  const segments = view.getUint16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let s = 0; s < segments; s += 1) {
    const start = view.getUint16(starts + s * 2);
    const end = view.getUint16(ends + s * 2);
    const delta = view.getInt16(deltas + s * 2);
    const rangeOffset = view.getUint16(rangeOffsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c += 1) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
        glyph = view.getUint16(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(c);
    }
  }
  return covered;
}

/** The 63 table tags WOFF2 encodes by index (WOFF2 §5.1); `cmap` is index 0. */
const KNOWN_TAGS: readonly string[] = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

/**
 * The characters a WOFF2 font draws. Reads the table directory (UIntBase128 lengths),
 * brotli-decompresses the font data and reads the `cmap` table, which WOFF2 never transforms.
 * Used by the Page Studio font-coverage test; server and build side only.
 */
export function woff2CharacterMap(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  if (font.byteLength < 48 || view.getUint32(0) !== 0x774f4632)
    throw new Error('not a WOFF2 font');
  const tables = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = font[at++] ?? 0;
      if (i === 0 && byte === 0x80) throw new Error('bad WOFF2 length');
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('bad WOFF2 length');
  };
  let offset = 0;
  let cmap: { offset: number; length: number } | undefined;
  for (let i = 0; i < tables; i += 1) {
    const flags = font[at++] ?? 0;
    let tag: string;
    if ((flags & 0x3f) === 63) {
      tag = String.fromCharCode(...font.subarray(at, at + 4));
      at += 4;
    } else tag = KNOWN_TAGS[flags & 0x3f] ?? '';
    const version = (flags >> 6) & 3;
    const length = base128();
    // glyf and loca are transformed at version 0; every other table at a non-zero version.
    const transformed =
      tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const stored = transformed ? base128() : length;
    if (tag === 'cmap') cmap = { offset, length: stored };
    offset += stored;
  }
  if (!cmap) throw new Error('font has no cmap table');
  const data = brotliDecompressSync(font.subarray(at, at + compressedSize));
  return cmapOf(data.subarray(cmap.offset, cmap.offset + cmap.length));
}

/** Whether a font with this character map draws every character of `text`. */
export function setsIn(text: string, covered: ReadonlySet<number>): boolean {
  for (const character of text.normalize('NFC'))
    if (!covered.has(character.codePointAt(0) ?? 0)) return false;
  return true;
}
