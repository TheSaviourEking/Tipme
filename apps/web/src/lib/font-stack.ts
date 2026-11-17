/**
 * Letters Nigerian names and money need that DM Serif Display and Manrope do not draw: ₦, the
 * combining marks (Ẹ̀ written as E + U+0323 + U+0300), Latin Extended-B and IPA (Hausa ɓ ɗ ƙ ƴ)
 * and Latin Extended Additional (Yoruba ẹ ọ ṣ). The shipped Inter face draws all of them
 * (checked with test/font-cmap.test.mjs). The fallback face covers only these ranges, so a page
 * whose text has none of them never downloads it.
 */
export const GLYPH_FALLBACK_RANGE =
  'U+20A6, U+0300-036F, U+0180-024F, U+0250-02AF, U+1E00-1EFF';

/**
 * A next/font family list with the glyph fallback put straight after the face itself:
 * `'Manrope', 'Manrope Fallback'` becomes `'Manrope', 'Inter Glyphs', 'Manrope Fallback'`.
 * next/font's own metric fallback is `local(Arial)` with no unicode-range, so if it came first
 * a missing letter would be drawn in the visitor's Arial (or nothing like it) instead of Inter.
 */
export function withGlyphFallback(stack: string, glyphs: string): string {
  const [face, ...rest] = stack.split(',').map((family) => family.trim());
  return [face, glyphs, ...rest].join(', ');
}
