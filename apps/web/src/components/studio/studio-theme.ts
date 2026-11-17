/**
 * Page Studio theme (plan Task 5): the only bridge from a Studio document to CSS. Every value
 * comes from the colour engine, the type scale, fixed steps or the font registry; nothing a person
 * typed reaches a style. Plain TypeScript with no `@/` imports, so its unit test runs in Node.
 */
import {
  RENDITION_WIDTHS,
  STUDIO_FONTS,
  STUDIO_IMAGE_ASPECT,
  STUDIO_SPACING,
  contrastRatio,
  studioTypeScale,
  type StudioDocument,
  type StudioFont,
  type StudioPalette,
  type StudioTokens,
} from '@tipme/contracts';

/** Colour roles, as CSS names. Each is set per mode (`--studio-l-*`, `--studio-d-*`). */
export const STUDIO_COLOUR_TOKENS = [
  'page',
  'card',
  'tint',
  'line',
  'control',
  'text',
  'muted',
  'heading',
  'link',
  'accent',
  'button',
  'button-text',
  'button-edge',
  'focus',
  'band',
  'band-text',
  'second-fill',
  'second-on-fill',
  'second-text',
] as const;
export type StudioColourToken = (typeof STUDIO_COLOUR_TOKENS)[number];

type Style = Record<`--studio-${string}`, string>;

function coloursOf(t: StudioTokens): Record<StudioColourToken, string> {
  // A button too close to its surfaces gets a control-coloured edge (≥3:1); otherwise its edge is
  // its own fill, so nothing shows.
  const seen = Math.min(
    contrastRatio(t.button, t.page),
    contrastRatio(t.button, t.card),
    contrastRatio(t.button, t.tint),
  );
  return {
    page: t.page,
    card: t.card,
    tint: t.tint,
    line: t.line,
    control: t.control,
    text: t.text,
    muted: t.muted,
    heading: t.heading,
    link: t.link,
    accent: t.accent,
    button: t.button,
    'button-text': t.buttonText,
    'button-edge': seen >= 3 ? t.button : t.control,
    focus: t.focus,
    band: t.band,
    'band-text': t.bandText,
    // One brand colour: "second" rows can't exist (the schema refuses them); these mirror the band.
    'second-fill': t.second?.fill ?? t.band,
    'second-on-fill': t.second?.onFill ?? t.bandText,
    'second-text': t.second?.text ?? t.link,
  };
}

/** A clamp() between a 320px and a 1440px screen, rounded so it never passes `min` at 320. */
function fluid(min: number, max: number): string {
  const slope = (max - min) / 1120;
  const rem = Math.floor(((min - slope * 320) / 16) * 1e4) / 1e4;
  return `clamp(${min}px, ${rem}rem + ${Math.round(slope * 100 * 1e4) / 1e4}vw, ${max}px)`;
}

const RADIUS = { square: [0, 0], soft: [10, 10], round: [20, 999] } as const;

export function studioFont(id: string): StudioFont {
  return (
    STUDIO_FONTS.find((f) => f.id === id) ?? (STUDIO_FONTS[0] as StudioFont)
  );
}

/**
 * `'Studio Nunito', var(--font-glyph-fallback, …), 'Studio Nunito Fallback', sans-serif`. The
 * root layout's Inter face (unicode-range: ₦, tone marks, ɓ ɗ ƙ ƴ, ẹ ọ ṣ) comes straight after
 * the chosen face, so a letter it lacks (Nunito has no ƙ) is drawn in Inter, not a system font.
 */
export function studioFontStack(font: StudioFont): string {
  const generic = font.fallback.family === 'Georgia' ? 'serif' : 'sans-serif';
  return `'Studio ${font.name}', var(--font-glyph-fallback, 'Studio Glyphs'), 'Studio ${font.name} Fallback', ${generic}`;
}

/**
 * The custom properties a Studio page's root element carries: colours for the modes it uses, type
 * sizes, spacing, corners and fonts. Dark colours apply under `[data-mode="dark"]`, and under
 * `[data-mode="auto"]` when the visitor prefers dark (studio.css).
 */
export function studioStyle(
  doc: StudioDocument,
  palette: StudioPalette,
): Style {
  const style: Style = {};
  const modes =
    doc.mode === 'auto' ? (['light', 'dark'] as const) : ([doc.mode] as const);
  for (const mode of modes) {
    const prefix = mode === 'light' ? 'l' : 'd';
    for (const [name, value] of Object.entries(coloursOf(palette[mode])))
      style[`--studio-${prefix}-${name}`] = value;
  }
  for (const [role, size] of Object.entries(studioTypeScale(doc.scale))) {
    style[`--studio-size-${role}`] = size.css;
    style[`--studio-lh-${role}`] = String(size.lineHeight);
  }
  for (const [step, { min, max }] of Object.entries(STUDIO_SPACING))
    style[`--studio-space-${step}`] = fluid(min, max);
  const [radius, button] = RADIUS[doc.corners];
  style['--studio-radius'] = `${radius}px`;
  style['--studio-radius-button'] = `${button}px`;
  const heading = studioFont(doc.fonts.heading);
  const body = studioFont(doc.fonts.body);
  style['--studio-font-heading'] = studioFontStack(heading);
  style['--studio-font-body'] = studioFontStack(body);
  style['--studio-weight-heading'] = String(heading.headingWeight);
  style['--studio-weight-body'] = String(body.bodyWeight ?? 400);
  return style;
}

/**
 * `@font-face` rules for this page's families only (one file each, at most two), plus a local
 * fallback face per family scaled to the same width and line box, so the swap barely moves text.
 */
export function studioFontFaces(fonts: StudioDocument['fonts']): string {
  const families = [...new Set([fonts.heading, fonts.body])].map(studioFont);
  return families
    .map((f) => {
      const faces = f.files
        .map(
          (file) =>
            `@font-face {\n  font-family: 'Studio ${f.name}';\n  src: url('${file.path}') format('woff2');\n  font-weight: ${file.weight};\n  font-style: normal;\n  font-display: swap;\n}`,
        )
        .join('\n');
      const fb = f.fallback;
      return `${faces}\n@font-face {\n  font-family: 'Studio ${f.name} Fallback';\n  src: local('${fb.family}');\n  size-adjust: ${fb.sizeAdjust};\n  ascent-override: ${fb.ascentOverride};\n  descent-override: ${fb.descentOverride};\n  line-gap-override: 0%;\n}`;
    })
    .join('\n');
}

export type StudioShape = keyof typeof STUDIO_IMAGE_ASPECT;

/**
 * `src`, `srcSet` and intrinsic size for one Studio photo in one crop. Renditions are made at
 * 480, 960 and 1440 wide and never upscaled (Task 7): a rendition wider than the usable crop of
 * the source is not offered. Files live at `<path>/<shape>-<width>`.
 */
export function studioImageSources(
  image: { path: string; width: number; height: number },
  shape: StudioShape,
): { src: string; srcSet: string; width: number; height: number } {
  const aspect = STUDIO_IMAGE_ASPECT[shape];
  const usable = Math.min(image.width, image.height * aspect);
  const widths = RENDITION_WIDTHS.filter((w, i) => i === 0 || w <= usable);
  const url = (w: number) => `${image.path}/${shape}-${w}`;
  const largest = widths[widths.length - 1] ?? 480;
  return {
    src: url(widths[0] ?? 480),
    srcSet: widths.map((w) => `${url(w)} ${w}w`).join(', '),
    width: largest,
    height: Math.round(largest / aspect),
  };
}
