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
 * quiet (builder's call). `'bg'` ends on the page's own bg. Styles whose gradient cover is not an
 * accent tint (Journal's is flat `el2`) are absent.
 */
const GRADIENT: Partial<
  Record<
    StudioStyleId,
    {
      light: [number, number | 'bg'];
      dark: [number, number | 'bg'];
      chroma?: number;
    }
  >
> = {
  clear: { light: [0.96, 0.9], dark: [0.28, 0.22] },
  // Tiles (§9.7): "a soft two-tint accent tile at low chroma", Clear's two tints (builder's call).
  tiles: { light: [0.96, 0.9], dark: [0.28, 0.22] },
  // Linen (§9.8): a warm accent tint at L .94 fading to bg. Dark mode isn't drawn: the tint starts
  // at L .30, just above Linen's dark bg, so the frame never glows (builder's call, as Clear's).
  linen: { light: [0.94, 'bg'], dark: [0.3, 'bg'] },
  // Stage (§9.4): a deep accent, OKLCH L .30, fading to bg, in both modes. Deep, so the accent's own
  // chroma (in gamut), not the quiet cap (builder's call).
  stage: { light: [0.3, 'bg'], dark: [0.3, 'bg'], chroma: Infinity },
  // Creator (addendum §7.1): a deep accent, L .30 in dark and .92 in light, fading to bg, at the
  // accent's own chroma (in gamut). Light stays pale, so no header is laid over it (§6.7).
  creator: { light: [0.92, 'bg'], dark: [0.3, 'bg'], chroma: Infinity },
};
const GRADIENT_CHROMA = 0.035;

function withDerived(
  style: StudioStyleId,
  mode: 'light' | 'dark',
  tokens: StudioTokenMap,
): StudioTokenMap {
  const gradient = GRADIENT[style];
  const stops = gradient?.[mode];
  const acc = tokens.acc;
  if (!stops || !acc || !isHex(acc)) return tokens;
  const { c, h } = hexToOklch(acc);
  const chroma = Math.min(c, gradient.chroma ?? GRADIENT_CHROMA);
  const [from, to] = stops.map((l) =>
    l === 'bg' ? tokens.bg! : oklchToHex({ l, c: chroma, h }),
  );
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

/** The neutrals the site's own header and footer take on a styled page (owner, ruling P). */
const CHROME_KEYS = ['bg', 'card', 'el2', 'fg', 'fg2', 'line'] as const;

/**
 * The page's neutrals on <html>, where the site's header and footer (outside `.studio`) can read
 * them (frame.css maps the site's own tokens to these there). Neutrals only: the accent never
 * reaches the chrome, save Signboard's label colour for a header over its band. Auto: light, then dark inside `prefers-color-scheme: dark`.
 */
export function chromeCss(
  style: StudioStyleId,
  palette: { light: StudioTokenMap; dark: StudioTokenMap },
  mode: 'light' | 'dark' | 'auto',
): string {
  const block = (m: 'light' | 'dark') => {
    const t = modeTokens(style, palette, m);
    // Signboard's band is the accent; a header over it writes in the band's label colour.
    const keys =
      style === 'signboard' ? [...CHROME_KEYS, 'accLabel'] : CHROME_KEYS;
    const own = Object.fromEntries(
      keys.filter((k) => t[k] !== undefined).map((k) => [k, t[k]!]),
    );
    const body = Object.entries(styleTokens(own))
      .map(([key, value]) => `${key}:${value};`)
      .join('');
    return `html:has(.studio[data-style]){${body}}`;
  };
  if (mode !== 'auto') return block(mode);
  return `${block('light')}@media (prefers-color-scheme: dark){${block('dark')}}`;
}
