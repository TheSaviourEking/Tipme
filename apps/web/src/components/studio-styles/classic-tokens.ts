/**
 * Classic's choices as tokens (spec 2026-11-17-page-studio-styles §9.1). A Classic page with any
 * choice keeps today's markup and stylesheet; classic.css points today's tokens (tokens.css) at
 * these `--studio-*` values, set on `:root` while a Classic page is shown, so the header's
 * wordmark and the page around the sheet follow too. With today's purple in light mode every value
 * is today's own (test/studio-classic.test.mjs proves it against tokens.css), so only what the
 * person chose changes. Plain TypeScript, so its test runs in Node.
 */
import {
  hexToOklch,
  isHex,
  oklchToHex,
  type Hex,
  type StudioTokenMap,
} from '@tipme/contracts';
import { styleTokens } from './style-tokens';

type Mode = 'light' | 'dark';

/** Today's shadows (tokens.css), as rgba() so they are plain token values. */
const SHADOWS_LIGHT = {
  shFrame: '0 1px 2px rgba(20,18,16,.06), 0 32px 64px -36px rgba(20,18,16,.34)',
  shInst:
    '0 1px 1px rgba(20,18,16,.08), 0 8px 16px -6px rgba(20,18,16,.10), 0 40px 72px -28px rgba(20,18,16,.32)',
  shKey: '0 1px 1px rgba(20,18,16,.10), 0 5px 14px rgba(20,18,16,.07)',
  shRec:
    'inset 0 1px 2px rgba(20,18,16,.11), inset 0 -1px 0 rgba(255,255,255,.80)',
  shTip:
    'inset 0 1px 0 rgba(255,255,255,.20), 0 2px 3px rgba(20,18,16,.24), 0 10px 18px -8px rgba(20,18,16,.45)',
  shTipDown:
    'inset 0 1px 0 rgba(255,255,255,.14), 0 1px 1px rgba(20,18,16,.30)',
  shBar: '0 -8px 24px rgba(20,18,16,.08)',
} as const;

/** Today's purple key: its edge (the purple mixed with 16% black) and its shadow's tint. */
const PURPLE_EDGE = '#662ad1';
const PURPLE_SHADE = '#3a1183';
/** The canvas's dark purple, and today's link-hover ink (--brand-ink). */
const INK = { light: '#4d16a8', dark: '#c8aeff' } as const;
/**
 * A chosen accent's key edge: about 10% darker in OKLCH (§9.1, my call), chroma eased by as much
 * so the colour stays in gamut. The shadow tint keeps today's ratio to the purple
 * (#3a1183 / #7a32f9: lightness 0.61, chroma 0.63) on the accent's hue.
 */
const EDGE = 0.9;
const SHADE = { l: 0.61, c: 0.63 } as const;
/** The gradient cover's two stops, on the accent's hue (§9.1, builder's call on the values). */
const COVER = {
  light: { from: { l: 0.9, c: 0.06 }, to: { l: 0.62, c: 0.16 } },
  dark: { from: { l: 0.42, c: 0.1 }, to: { l: 0.26, c: 0.06 } },
} as const;

const shade = (hex: Hex, l: number, c: number) => {
  const o = hexToOklch(hex);
  return oklchToHex({ l: o.l * l, c: o.c * c, h: o.h });
};
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');

/**
 * One mode's Classic tokens: the registry's (`studioTokens('classic', …)[mode]`) plus what the
 * page derives from them. `purple` is the default accent (`accent: null`), which keeps today's
 * exact key edge, shadow tint and link ink.
 */
export function classicTokens(
  base: StudioTokenMap,
  mode: Mode,
  purple: boolean,
): StudioTokenMap {
  const acc: Hex = base.acc && isHex(base.acc) ? base.acc : '#7a32f9';
  const light = mode === 'light';
  const hue = hexToOklch(acc);
  const stop = (s: { l: number; c: number }) =>
    oklchToHex({ l: s.l, c: Math.min(hue.c, s.c), h: hue.h });
  const tint = rgb(purple ? PURPLE_SHADE : shade(acc, SHADE.l, SHADE.c));
  const off = 'none';
  return {
    ...base,
    accEdge: light ? (purple ? PURPLE_EDGE : shade(acc, EDGE, EDGE)) : acc,
    ink: purple ? INK[mode] : (base.accText ?? acc),
    accGloss: light ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,0)',
    // The Tip key keeps Classic's ink: black in light, the paper colour in dark (§9.1).
    tip: light ? '#000000' : '#f3f2ee',
    tipFg: light ? '#ffffff' : '#141210',
    tipGloss: light ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,0)',
    badgeFg: light ? '#ffffff' : '#141210',
    edge: light ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.06)',
    subtle: light ? '#f7f6f2' : (base.card ?? '#1e1b18'),
    lineSoft: light ? '#dfded8' : (base.rule ?? 'rgba(255,255,255,.12)'),
    boxLine: light
      ? 'rgba(20,18,16,.20)'
      : (base.border ?? 'rgba(255,255,255,.14)'),
    scheme: light ? 'normal' : 'dark',
    // Today's error red is about 1.4:1 on the dark card and the canvas draws no dark red, so dark
    // errors take Classic's ink, as Clear's do (frame.css). Light keeps today's red.
    danger: light ? '#9b2820' : (base.fg ?? '#f3f2ee'),
    shSig: light
      ? `inset 0 1px 0 rgba(255,255,255,.22), 0 1px 2px rgba(${tint},.28), 0 4px 10px -6px rgba(${tint},.30)`
      : off,
    ...(light
      ? SHADOWS_LIGHT
      : Object.fromEntries(Object.keys(SHADOWS_LIGHT).map((k) => [k, off]))),
    coverFrom: stop(COVER[mode].from),
    coverTo: stop(COVER[mode].to),
  };
}

const ROOT = ':root:has(.profile-page--studio[data-style="classic"]';
const block = (selector: string, tokens: StudioTokenMap) =>
  `${selector}{${Object.entries(styleTokens(tokens))
    .map(([k, v]) => `${k}:${v};`)
    .join('')}}`;

/**
 * The page's token rule: the chosen mode's tokens on `:root` while a Classic page is shown; auto
 * adds the dark ones inside `prefers-color-scheme: dark` (pure CSS, no script, no flash).
 */
export function classicCss(
  palette: { light: StudioTokenMap; dark: StudioTokenMap },
  mode: 'light' | 'dark' | 'auto',
  purple: boolean,
): string {
  const first = mode === 'dark' ? 'dark' : 'light';
  const css = block(
    `${ROOT}[data-mode])`,
    classicTokens(palette[first], first, purple),
  );
  return mode === 'auto'
    ? `${css}@media (prefers-color-scheme: dark){${block(`${ROOT}[data-mode="auto"])`, classicTokens(palette.dark, 'dark', purple))}}`
    : css;
}
