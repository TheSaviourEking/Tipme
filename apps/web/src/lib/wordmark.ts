/**
 * The TipMe logo: the owner's final files (PNG, 24 Nov 2026) in public/brand. The wordmark is the
 * heart of two figures, "tip" and "me" and ™; the mark is the heart alone. Light files are black
 * and purple (for light grounds); the dark wordmark has white for black (for dark grounds).
 *
 * On the site the logo is drawn from two masks cut from the light file (`scripts/design/
 * brand-assets.mjs`): its black (ink) and its purple (accent), so a page can give each part its
 * colour (globals.css `.wordmark`). Images that cannot use CSS (share cards, email) load the files.
 */
export const WORDMARK = {
  width: 1383,
  height: 380,
  light: '/brand/tipme-wordmark-light.png',
  dark: '/brand/tipme-wordmark-dark.png',
} as const;

export const MARK = {
  width: 400,
  height: 380,
  src: '/brand/tipme-mark.png',
} as const;
