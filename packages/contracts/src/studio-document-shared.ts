/**
 * Internal to the contracts package (not re-exported from index.ts): the text and value rules
 * the v1 and v2 Studio documents share, so the two cannot drift. `studio-document-v1.ts` keeps the
 * public `cleanStudioText` and `cleanStudioParagraph` by re-exporting them.
 */
import { STUDIO_LIMITS as L } from './studio-limits.js';

export const codePoints = (s: string) => [...s].length;

/**
 * One line of user text as stored: tabs and line breaks become spaces; C0 and C1 controls and the
 * bidi overrides and isolates (U+202A–202E, U+2066–2069) are removed; NFC; trimmed.
 */
export function cleanStudioText(s: string): string {
  return s
    .replace(/[\t\n\r]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .normalize('NFC')
    .trim();
}

/** A paragraph block: up to 4 paragraphs separated by one blank line, each cleaned to one line. */
export function cleanStudioParagraph(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(cleanStudioText)
    .filter((part) => part.length > 0)
    .slice(0, L.paragraphBreaks + 1)
    .join('\n\n');
}

/** Cleaned and cut to `max` code points (cleaning again, since a cut can leave a space). */
export function fit(
  s: unknown,
  max: number,
  clean: (s: string) => string = cleanStudioText,
): string {
  let out = clean(typeof s === 'string' ? s : '');
  for (let i = 0; i < 4 && codePoints(out) > max; i += 1)
    out = clean([...out].slice(0, max).join(''));
  return codePoints(out) > max ? [...out].slice(0, max).join('') : out;
}

export const isLine = (s: string, max: number) =>
  cleanStudioText(s) === s && codePoints(s) <= max;
export const isParagraph = (s: string) =>
  cleanStudioParagraph(s) === s && codePoints(s) <= L.paragraphText;

export const ID = /^[a-z0-9]{8}$/;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

export function isKobo(s: string): boolean {
  if (!/^[1-9]\d{0,12}$/.test(s)) return false;
  const v = BigInt(s);
  return v % 100n === 0n && v >= 100n && v <= L.priceMaxMinor;
}

export type Loose = Record<string, unknown>;
export const isObj = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const optional = <T>(v: T | '' | undefined): T | undefined =>
  v === '' ? undefined : v;
export const without = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
