/**
 * A styled page's fonts (spec 2026-11-17-page-studio-styles §4.1, §4.3, §13): `@font-face` only
 * for Studio Inter (400–800, every UI, body and money face) and the style's own display face, each
 * with a metric-matched local fallback so the swap barely moves text (CLS ≤ 0.05). At most two
 * families, four files and 200 KB, all from our origin. Only the face that sets the name is
 * preloaded: Inter when the style has no display face, or when the name has a letter the display
 * face can't draw (then the whole name is Inter, never a letter-by-letter mix).
 */
import {
  STUDIO_FONTS,
  STUDIO_STYLES,
  type StudioFont,
  type StudioStyleId,
} from '@tipme/contracts';

const font = (id: string): StudioFont => {
  const found = STUDIO_FONTS.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown Studio font ${id}`);
  return found;
};
const INTER = font('inter');

/** The style's display face, or null when Inter sets the name too. */
export function displayFace(style: StudioStyleId): StudioFont | null {
  const id = STUDIO_STYLES[style].displayFont;
  return id && id !== 'inter' ? font(id) : null;
}

/** Whether the display face lacks a letter of `text` (the whole string is then set in Inter). */
export function needsInter(style: StudioStyleId, text: string): boolean {
  const face = displayFace(style);
  return Boolean(
    face &&
    face.missing.length > 0 &&
    [...text].some((c) => face.missing.includes(c.codePointAt(0) ?? 0)),
  );
}

function faces(f: StudioFont): string {
  const files = f.files
    .map(
      (file) =>
        `@font-face{font-family:'Studio ${f.name}';src:url('${file.path}') format('woff2');font-weight:${file.weight};font-style:${file.style};font-display:swap}`,
    )
    .join('');
  const fb = f.fallback;
  return `${files}@font-face{font-family:'Studio ${f.name} Fallback';src:local('${fb.family}');size-adjust:${fb.sizeAdjust};ascent-override:${fb.ascentOverride};descent-override:${fb.descentOverride};line-gap-override:0%}`;
}

/** The page's `@font-face` rules: Inter, then the style's display face if it has one. */
export function styleFontFaces(style: StudioStyleId): string {
  const display = displayFace(style);
  return [INTER, ...(display ? [display] : [])].map(faces).join('');
}

/** The one file to preload: the upright file of the face that sets this name. */
export function styleFontPreload(style: StudioStyleId, name: string): string {
  const display = displayFace(style);
  const face = display && !needsInter(style, name) ? display : INTER;
  return (face.files.find((f) => f.style === 'normal') ?? face.files[0]!).path;
}
