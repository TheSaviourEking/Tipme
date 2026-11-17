/**
 * The only bridge from a published style to CSS (spec 2026-11-17-page-studio-styles §13): the
 * resolved token map (`PublicStudio.palette`, from `studioTokens`) as `--studio-*` custom
 * properties, plus the few values a style derives from its accent. Every key and value comes from
 * the registry; nothing a person typed reaches a style. Plain TypeScript, so its test runs in Node.
 */
import {
  hexToOklch,
  isHex,
  oklchToHex,
  type StudioStyleId,
  type StudioTokenMap,
} from '@tipme/contracts';

type Tokens = Record<`--studio-${string}`, string>;

const KEY = /^[a-zA-Z0-9]+$/;
// Hex colours, rgba(), Tiles' shadow list and `none`: no quotes, semicolons, braces or url().
const VALUE = /^[#a-zA-Z0-9(),.%\s-]+$/;

/**
 * The gradient cover's two stops (§9.2 "Gradient": two tints of the accent at low chroma). The
 * lightness pairs are the spec's; the chroma is the accent's, capped at 0.035 so the tint stays
 * quiet (builder's call). Styles without a gradient cover are absent.
 */
const GRADIENT: Partial<
  Record<StudioStyleId, { light: [number, number]; dark: [number, number] }>
> = {
  clear: { light: [0.96, 0.9], dark: [0.28, 0.22] },
};
const GRADIENT_CHROMA = 0.035;

function withDerived(
  style: StudioStyleId,
  mode: 'light' | 'dark',
  tokens: StudioTokenMap,
): StudioTokenMap {
  const stops = GRADIENT[style]?.[mode];
  const acc = tokens.acc;
  if (!stops || !acc || !isHex(acc)) return tokens;
  const { c, h } = hexToOklch(acc);
  const chroma = Math.min(c, GRADIENT_CHROMA);
  const [from, to] = stops.map((l) => oklchToHex({ l, c: chroma, h }));
  return { ...tokens, coverFrom: from!, coverTo: to! };
}

/** One mode's tokens with the style's derived values. */
export function modeTokens(
  style: StudioStyleId,
  palette: { light: StudioTokenMap; dark: StudioTokenMap },
  mode: 'light' | 'dark',
): StudioTokenMap {
  return withDerived(style, mode, palette[mode]);
}

/** A token map as custom properties, dropping anything that is not a plain key and value. */
export function styleTokens(tokens: StudioTokenMap): Tokens {
  const out: Tokens = {};
  for (const [key, value] of Object.entries(tokens))
    if (KEY.test(key) && VALUE.test(value)) out[`--studio-${key}`] = value;
  return out;
}

/**
 * Auto mode (§4.4: pure CSS, no script, no flash): the dark tokens inside `prefers-color-scheme:
 * dark`. They must win over the light tokens on the root's own style, hence `!important`.
 */
export function autoDarkCss(tokens: StudioTokenMap): string {
  const body = Object.entries(styleTokens(tokens))
    .map(([key, value]) => `${key}:${value} !important;`)
    .join('');
  return `@media (prefers-color-scheme: dark){.studio[data-mode="auto"]{${body}}}`;
}
