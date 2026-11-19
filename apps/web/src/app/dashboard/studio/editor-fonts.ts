/**
 * The style cards' display faces (styles spec §10.2: each card is set in the person's own name and
 * the style's face). Editor-only `@font-face` rules for the upright files of the faces the cards
 * use (Journal's, Signboard's, Sprint's, Linen's; Classic's is the site's DM Serif, the rest are
 * Inter), with `font-display: swap`, so the editor's own Manrope never waits for them. The files
 * are the same ones a page loads, from our origin. A published page never gets these rules.
 */
import {
  STUDIO_FONTS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
} from '@tipme/contracts';

/** The family name a card uses for a style's face (studio-editor.css names the same). */
export const cardFamily = (name: string) => `Studio Card ${name}`;

export function editorFontFaces(): string {
  const ids = new Set(
    STUDIO_STYLE_IDS.map((s) => STUDIO_STYLES[s].displayFont).filter(
      (f): f is NonNullable<typeof f> =>
        f !== null && f !== 'inter' && f !== 'dm-serif-display',
    ),
  );
  return STUDIO_FONTS.filter((f) => ids.has(f.id))
    .flatMap((f) =>
      f.files
        .filter((file) => file.style === 'normal')
        .map(
          (file) =>
            `@font-face{font-family:'${cardFamily(f.name)}';src:url('${file.path}') format('woff2');font-weight:${file.weight};font-style:normal;font-display:swap}`,
        ),
    )
    .join('');
}
