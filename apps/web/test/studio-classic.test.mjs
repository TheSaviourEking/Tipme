import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { unguarded } from './shown-page.mjs';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_ACCENTS,
  STUDIO_STYLES,
  contrastRatio,
  hexToOklch,
  STUDIO_HEADING_PX,
  resolveStudio,
  studioSlotWidth,
  studioTokens,
} from '@tipme/contracts';

// Classic's choices, PR 2b (spec 2026-11-17-page-studio-styles §2.5, §4.3, §9.1, §13). A Classic
// page with any choice renders today's standard markup (StandardProfile) with Classic's token
// overrides, `data-mode` and its blocks; never the new styles' frame. Transpiled as in
// studio-style-page.test.mjs, its app imports pointed at stand-ins.
const dir = new URL('../src/components/studio-styles/', import.meta.url);
const out = new URL(
  '../node_modules/.cache/studio-classic-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });

const STUBS = {
  '@/components/avatar': './stub-avatar.mjs',
  '@tipme/ui': './stub-ui.mjs',
  '@/components/profile/link-badge': './stub-link-badge.mjs',
  '@/components/profile/standard-profile': './standard-profile.mjs',
  '@/components/money': './stub-money.mjs',
  '@/lib/avatar-source': './stub-avatar-source.mjs',
  './video-embed': './stub-video.mjs',
  './style-sheets': './stub-sheets.mjs',
  './parts': './parts.mjs',
  './style-fonts': './style-fonts.mjs',
  './style-tokens': './style-tokens.mjs',
  './classic-tokens': './classic-tokens.mjs',
  './classic': './classic.mjs',
  // parts.tsx draws Creator's "Powered by" with the wordmark and Next's link.
  '@/components/brand': './stub-brand.mjs',
  'next/link': './stub-link.mjs',
};
function build(name, file) {
  assert.ok(existsSync(file), `${file.pathname} exists`);
  let js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const [from, to] of Object.entries(STUBS))
    js = js
      .replaceAll(`"${from}"`, `"${to}"`)
      .replaceAll(`'${from}'`, `'${to}'`);
  writeFileSync(new URL(name, out), js);
}
const stub = (name, code) => writeFileSync(new URL(name, out), code);
stub(
  'stub-brand.mjs',
  `import { createElement } from 'react';
export const Wordmark = (p) => createElement('span', { className: 'wordmark', 'aria-hidden': true });`,
);
stub(
  'stub-link.mjs',
  `import { createElement } from 'react';
export default ({ prefetch, ...p }) => createElement('a', p);`,
);
stub(
  'stub-avatar.mjs',
  `import { createElement } from 'react';
export const AvatarImage = (p) => createElement('img', { className: p.className, alt: p.name });`,
);
stub(
  'stub-ui.mjs',
  `import { createElement } from 'react';
export const ProBadge = (p) => createElement('span', { className: p.className }, 'Pro');`,
);
stub(
  'stub-link-badge.mjs',
  `import { createElement } from 'react';
export const LinkBadge = () => createElement('span', { className: 'link-badge' });`,
);
stub(
  'stub-money.mjs',
  `import { createElement } from 'react';
export const Money = (p) => createElement('span', { className: 'money' }, '₦' + p.minor);`,
);
stub(
  'stub-avatar-source.mjs',
  `export const API_ORIGIN = 'https://api.tipme.example';`,
);
stub(
  'stub-video.mjs',
  `import { createElement } from 'react';
export const VideoEmbed = () => createElement('button', null, 'Play');`,
);
stub(
  'stub-sheets.mjs',
  `import { createElement } from 'react';
export const StyleSheet = (p) => createElement('i', { 'data-sheet': p.styleId });`,
);
build('style-tokens.mjs', new URL('style-tokens.ts', dir));
build('style-fonts.mjs', new URL('style-fonts.ts', dir));
build('parts.mjs', new URL('parts.tsx', dir));
build('standard-profile.mjs', new URL('../profile/standard-profile.tsx', dir));
build('classic-tokens.mjs', new URL('classic-tokens.ts', dir));
build('classic.mjs', new URL('classic.tsx', dir));
build('style-page.mjs', new URL('style-page.tsx', dir));
const { classicTokens, classicCss } = await import(
  new URL('classic-tokens.mjs', out)
);
const { ClassicStudio } = await import(new URL('classic.mjs', out));
const { renderStyled } = await import(new URL('style-page.mjs', out));
const { StandardProfile } = await import(new URL('standard-profile.mjs', out));

// Quotes normalised: Prettier writes the sheet's attribute values in single quotes.
const classicSheet = unguarded(
  readFileSync(new URL('classic.css', dir), 'utf8'),
).replaceAll("'", '"');

/** Every rule of a stylesheet: [{ selector, decls: [[prop, value]] }], at-rules flattened. */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(re)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    const decls = m[2]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const at = d.indexOf(':');
        return [
          d.slice(0, at).trim(),
          d
            .slice(at + 1)
            .replace(/\s+/g, ' ')
            .replace(/\( /g, '(')
            .replace(/ \)/g, ')')
            .trim(),
        ];
      });
    found.push({ selector, decls });
  }
  return found;
}

const IMG = '00000001-0000-4000-8000-000000000000';
const doc = (over = {}) =>
  resolveStudio(
    {
      v: 2,
      style: 'classic',
      accent: null,
      mode: 'light',
      cover: 'yours',
      blocks: [
        { id: 'head0001', kind: 'text', variant: 'heading', text: 'News' },
        {
          id: 'text0001',
          kind: 'text',
          variant: 'paragraph',
          text: 'Studio time.',
        },
        {
          id: 'gall0001',
          kind: 'gallery',
          images: [{ imageId: IMG, alt: 'A stage at night' }],
        },
      ],
      ...over,
    },
    '2026-11-17',
  );
const props = (document) => ({
  studio: {
    document,
    images: {
      [IMG]: {
        path: `/dev/studio-lab/image/${IMG}`,
        width: 2400,
        height: 1600,
      },
    },
    palette: studioTokens(document.style, document.accent),
    checkVersion: DESIGN_CHECK_VERSION,
  },
  profile: {
    handle: 'studiolab',
    displayName: 'Kemi Adeyinka',
    plan: 'pro',
  },
  coverArt: createElement('i', { 'data-part': 'cover-art' }),
  identity: createElement('i', { 'data-part': 'identity' }),
  tipBlock: createElement('i', { 'data-part': 'tip' }),
  footer: createElement('i', { 'data-part': 'foot' }),
});
const page = (over) =>
  renderToStaticMarkup(createElement(ClassicStudio, props(doc(over))));

// The accent's tokens, and the derived ones made from it.
const ACCENT_TOKENS = /var\(--studio-(acc\w*|ink|soft)\)/;

test('ClassicStudio renders the standard markup with Classic’s root, tokens and blocks after the tip panel', () => {
  const html = page({ accent: 'green', mode: 'dark' });
  assert.match(
    html,
    /^<main id="main" tabindex="-1" class="profile-page profile-page--studio" data-style="classic" data-mode="dark" data-cover="yours">/,
  );
  // Today's structure, in today's order, with the blocks after the tip panel.
  const at = (s) => html.indexOf(s);
  assert.ok(at('<style>') < at('class="profile-sheet"'));
  assert.ok(at('data-part="cover-art"') < at('class="profile-columns"'));
  assert.ok(at('data-part="identity"') < at('data-tip-panel'));
  assert.ok(at('data-part="tip"') < at('class="classic-blocks"'));
  assert.ok(at('class="classic-blocks"') < at('data-part="foot"'));
  assert.match(html, /<i data-sheet="classic"><\/i>/);
  // Not the new styles' frame.
  assert.doesNotMatch(html, /class="studio(-page|-tip)?"/);
  // The section title and the text, in Classic's block markup.
  assert.match(
    html,
    /<h2 class="studio-title studio-block--heading">News<\/h2>/,
  );
  assert.match(html, /studio-card studio-text/);
  // No new font: no @font-face and no preload.
  assert.doesNotMatch(html, /@font-face|rel="preload"/);
});

test('a Classic page without blocks has no blocks section', () => {
  const html = page({ accent: 'blue', blocks: [] });
  assert.doesNotMatch(html, /classic-blocks/);
});

test('renderStyled sends Classic to ClassicStudio and the other styles to the frame', () => {
  const classic = renderToStaticMarkup(renderStyled(props(doc())));
  assert.match(classic, /^<main[^>]+data-style="classic"/);
  const clear = renderToStaticMarkup(
    renderStyled(props(doc({ style: 'clear' }))),
  );
  assert.match(clear, /<div class="studio" data-style="clear"/);
  assert.doesNotMatch(clear, /profile-page/);
});

test('an accent replaces the purple only on the selected key, links, focus, the wordmark and the shared moment', () => {
  // Every declaration that draws with the accent, by what it styles.
  const uses = rules(classicSheet).flatMap(({ selector, decls }) =>
    decls
      .filter(([, value]) => ACCENT_TOKENS.test(value))
      .map(([prop]) => `${selector} | ${prop}`),
  );
  const S = '.profile-page--studio[data-style="classic"][data-mode]';
  assert.deepEqual(
    uses.sort(),
    [
      // The four: the focus ring and links (as tokens), the selected key, the wordmark.
      `:root:has(${S}) .brand__mark | --logo-accent`,
      `:root:has(${S}) | --brand-ink`,
      `:root:has(${S}) | --brand-primary`,
      `${S} .tip-remember input:checked | background`,
      `${S} .tip-remember input:checked | border-color`,
      `${S} .tip-remember input:checked::before | border-color`,
      `${S} .tm-amount-choice input:checked + span | background-color`,
      `${S} .tm-amount-choice input:checked + span | background-image`,
      `${S} .tm-amount-choice input:checked + span | border-color`,
      `${S} .tm-amount-choice input:checked + span | color`,
      // The shared moment ("Celebrating …"): its tint and its ink.
      `${S} .profile-celebration | background`,
      `${S} .profile-celebration | color`,
    ].sort(),
  );
  // The tokens: focus is the accent's text value, links too; the selected key's fill and label.
  const green = STUDIO_ACCENTS.green;
  for (const mode of ['light', 'dark']) {
    const t = classicTokens(
      studioTokens('classic', 'green')[mode],
      mode,
      false,
    );
    assert.equal(t.acc, green[mode].fill);
    assert.equal(t.accLabel, green[mode].label);
    assert.equal(t.accText, green[mode].text);
    assert.equal(t.ink, green[mode].text);
  }
  // The Tip key stays black ink in light and #f3f2ee in dark, whatever the accent.
  for (const accent of [null, 'green', 'amber']) {
    const pal = studioTokens('classic', accent);
    const light = classicTokens(pal.light, 'light', accent === null);
    const dark = classicTokens(pal.dark, 'dark', accent === null);
    assert.equal(light.tip, '#000000');
    assert.equal(light.tipFg, '#ffffff');
    assert.equal(dark.tip, '#f3f2ee');
    assert.equal(dark.tipFg, '#141210');
  }
  // The rendered page carries the accent as a token.
  assert.match(page({ accent: 'green' }), /--studio-acc:#0b7a4b;/);
});

test('the key edge is the accent fill about 10% darker in OKLCH', () => {
  for (const [id, accent] of Object.entries(STUDIO_ACCENTS)) {
    const t = classicTokens(studioTokens('classic', id).light, 'light', false);
    const fill = hexToOklch(accent.light.fill);
    const edge = hexToOklch(t.accEdge);
    const ratio = edge.l / fill.l;
    assert.ok(ratio > 0.88 && ratio < 0.92, `${id}: ${ratio.toFixed(3)}`);
    if (fill.c > 0.02)
      assert.ok(
        Math.abs(edge.h - fill.h) < 3,
        `${id}: hue ${edge.h} vs ${fill.h}`,
      );
  }
  // Today's purple keeps today's edge exactly (color-mix of the purple with 16% black).
  const purple = classicTokens(
    studioTokens('classic', null).light,
    'light',
    true,
  );
  assert.equal(purple.accEdge, '#662ad1');
  // Its shadow is today's recipe, tinted to the accent at the same alphas.
  assert.match(purple.shSig, /rgba\(58,17,131,\.28\).*rgba\(58,17,131,\.30\)/);
  const green = classicTokens(
    studioTokens('classic', 'green').light,
    'light',
    false,
  );
  assert.match(
    green.shSig,
    /^inset 0 1px 0 rgba\(255,255,255,\.22\), 0 1px 2px rgba\(\d+,\d+,\d+,\.28\), 0 4px 10px -6px rgba\(\d+,\d+,\d+,\.30\)$/,
  );
  assert.doesNotMatch(green.shSig, /58,17,131/);
});

test('dark Classic has no shadows or gloss, and uses the canvas’s derived palette', () => {
  for (const accent of [null, 'rose']) {
    const t = classicTokens(
      studioTokens('classic', accent).dark,
      'dark',
      accent === null,
    );
    for (const [key, value] of Object.entries(t))
      // A valid no-op, not `none`: some shadows sit in a list (the invalid field's red edge is
      // `var(--shadow-recessed), inset 3px 0 0 red`), and `none` there drops the whole list.
      if (/^sh/.test(key)) assert.equal(value, '0 0 0 transparent', key);
    for (const key of ['accGloss', 'tipGloss'])
      assert.equal(t[key], 'rgba(255,255,255,0)', key);
    assert.equal(t.scheme, 'dark');
    // §9.1 verbatim.
    assert.equal(t.bg, '#141210');
    assert.equal(t.card, '#1e1b18');
    assert.equal(t.el2, '#2a2622');
    assert.equal(t.base, '#2a2622');
    assert.equal(t.fg, '#f3f2ee');
    assert.equal(t.fg2, '#c9c4ba');
    assert.equal(t.fg3, '#a39e94');
    assert.equal(t.border, 'rgba(255,255,255,.14)');
    assert.equal(t.hair, 'rgba(255,255,255,.10)');
    assert.equal(t.rule, 'rgba(255,255,255,.12)');
  }
  // Today's error red (#9b2820) is about 1.4:1 on the dark card; the canvas draws no dark red,
  // so errors take Classic's ink there, as Clear's do (frame.css). Light keeps today's red.
  for (const mode of ['light', 'dark']) {
    const t = classicTokens(studioTokens('classic', null)[mode], mode, true);
    assert.equal(t.danger, mode === 'light' ? '#9b2820' : '#f3f2ee', mode);
  }
  const map = rules(classicSheet).find(
    (r) => r.selector.startsWith(':root:has(') && !r.selector.includes(' .'),
  );
  assert.ok(
    map.decls.some(
      ([p, v]) => p === '--state-danger' && v === 'var(--studio-danger)',
    ),
    '--state-danger follows the mode',
  );
  const purple = classicTokens(
    studioTokens('classic', null).dark,
    'dark',
    true,
  );
  assert.equal(purple.acc, '#c8aeff');
  assert.equal(purple.accLabel, '#141210');
  assert.equal(purple.ink, '#c8aeff');
  // Every shadow in the sheet comes from a token, so dark mode turns all of them off.
  for (const { selector, decls } of rules(classicSheet))
    for (const [prop, value] of decls)
      if (prop === 'box-shadow' || prop.startsWith('--shadow'))
        assert.match(value, /^var\(--studio-sh\w+\)$/, `${selector} ${prop}`);
});

test('the shared moment’s panel is the mode’s and accent’s own tint, its ink at 4.5:1 or better', () => {
  // Light with today's purple is today's lilac (tokens.css --brand-soft) under today's ink.
  const tokens = readFileSync(
    new URL('../../../packages/ui/src/tokens.css', import.meta.url),
    'utf8',
  );
  const lilac = /--brand-soft:\s*(#[0-9a-f]{6});/i.exec(tokens)?.[1];
  assert.equal(lilac, '#f1e9ff');
  const today = classicTokens(
    studioTokens('classic', null).light,
    'light',
    true,
  );
  assert.equal(today.soft, lilac);
  assert.equal(today.ink, '#4d16a8');
  for (const accent of [null, ...Object.keys(STUDIO_ACCENTS)])
    for (const mode of ['light', 'dark']) {
      const t = classicTokens(
        studioTokens('classic', accent)[mode],
        mode,
        accent === null,
      );
      const label = `${accent ?? 'purple'} ${mode}`;
      const ratio = contrastRatio(t.ink, t.soft);
      assert.ok(ratio >= 4.5, `${label}: ink ${ratio.toFixed(2)}:1`);
      const { l, c, h } = hexToOklch(t.soft);
      // Dark draws a dark panel (the bug: today's light lilac under the dark palette's light ink).
      if (mode === 'dark') assert.ok(l < 0.4, `${label}: L ${l.toFixed(2)}`);
      else assert.ok(l > 0.9, `${label}: L ${l.toFixed(2)}`);
      // A chosen accent's tint, not today's purple; quiet, on the accent's hue.
      if (accent !== null) {
        assert.notEqual(t.soft, lilac, label);
        const acc = hexToOklch(t.acc);
        assert.ok(c <= 0.04, `${label}: chroma ${c.toFixed(3)}`);
        if (acc.c > 0.05)
          assert.ok(
            Math.abs(((h - acc.h + 540) % 360) - 180) < 12,
            `${label}: hue ${h.toFixed(0)} vs ${acc.h.toFixed(0)}`,
          );
      }
    }
});

test('light Classic with today’s purple maps every token to today’s value', () => {
  // The values in packages/ui tokens.css, as the browser reads them.
  const tokens = readFileSync(
    new URL('../../../packages/ui/src/tokens.css', import.meta.url),
    'utf8',
  );
  const norm = (v) =>
    v
      .replace(/\s+/g, ' ')
      .replace(
        /rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/g,
        (_, r, g, b, a) => `rgba(${r},${g},${b},${Number(a) / 100})`,
      )
      .replace(
        /rgba\((\d+),(\d+),(\d+),\.(\d+)\)/g,
        (_, r, g, b, a) => `rgba(${r},${g},${b},${Number(`0.${a}`)})`,
      )
      .trim()
      .toLowerCase();
  const today = new Map(
    [...tokens.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      norm(m[2]),
    ]),
  );
  const t = classicTokens(studioTokens('classic', null).light, 'light', true);
  const S = ':root:has(.profile-page--studio[data-style="classic"][data-mode])';
  const map = rules(classicSheet).find((r) => r.selector === S);
  assert.ok(map, 'the token map rule');
  let checked = 0;
  for (const [prop, value] of map.decls) {
    const token = /^var\(--studio-(\w+)\)$/.exec(value)?.[1];
    if (!prop.startsWith('--') || !token) continue;
    assert.ok(today.has(prop), `${prop} is a tokens.css token`);
    assert.equal(norm(t[token]), today.get(prop), `${prop} (${token})`);
    checked += 1;
  }
  assert.ok(checked >= 15, `${checked} tokens mapped`);
});

test('gradient is a two-stop accent gradient in today’s cover shape; plain has no cover band', () => {
  const gradient = page({ accent: 'lagoon', cover: 'gradient' });
  assert.match(
    gradient,
    /<div class="profile-cover classic-cover" aria-hidden="true"><\/div>/,
  );
  assert.doesNotMatch(gradient, /cover-art/);
  const rule = rules(classicSheet).find((r) =>
    r.selector.endsWith('[data-cover="gradient"] .classic-cover'),
  );
  assert.ok(rule, 'the gradient rule');
  assert.deepEqual(rule.decls, [
    [
      'background',
      'linear-gradient(135deg, var(--studio-coverFrom), var(--studio-coverTo))',
    ],
  ]);
  for (const mode of ['light', 'dark']) {
    const t = classicTokens(
      studioTokens('classic', 'lagoon')[mode],
      mode,
      false,
    );
    const acc = hexToOklch(t.acc);
    for (const stop of [t.coverFrom, t.coverTo])
      assert.ok(Math.abs(hexToOklch(stop).h - acc.h) < 4, `${mode} ${stop}`);
    assert.notEqual(t.coverFrom, t.coverTo);
  }
  const plain = page({ cover: 'plain' });
  assert.doesNotMatch(plain, /profile-cover|cover-art/);
  assert.match(plain, /data-cover="plain"/);
  assert.match(page({ cover: 'yours' }), /data-part="cover-art"/);
});

test('auto mode is pure CSS: the dark tokens inside prefers-color-scheme', () => {
  const css = classicCss(studioTokens('classic', 'violet'), 'auto', false);
  const root = ':root:has(.profile-page--studio[data-style="classic"]';
  assert.ok(css.startsWith(`${root}[data-mode]){`));
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\)\{:root:has\(\.profile-page--studio\[data-style="classic"\]\[data-mode="auto"\]\)\{[^}]*--studio-bg:#141210;[^}]*--studio-shSig:0 0 0 transparent;/,
  );
  assert.match(css, /--studio-bg:#f3f2ee;/);
  // Dark mode alone needs no media query.
  const dark = classicCss(studioTokens('classic', 'violet'), 'dark', false);
  assert.doesNotMatch(dark, /@media/);
  assert.match(dark, /--studio-bg:#141210;/);
  // Only plain values reach CSS.
  assert.doesNotMatch(css, /[;{]\s*--studio-[^:]+:[^;]*[{}"'\\]/);
});

test('Classic’s stylesheet styles only a Classic page and loads only on one', () => {
  for (const { selector } of rules(classicSheet))
    for (const part of selector.split(','))
      assert.match(
        part.trim(),
        /^(:root:has\()?\.profile-page--studio\[data-style="classic"\]/,
        part,
      );
  const sheets = readFileSync(new URL('style-sheets.tsx', dir), 'utf8');
  assert.match(
    sheets,
    /classic: dynamic\(\(\) => import\('\.\/sheets\/classic'\)\)/,
  );
  assert.match(
    readFileSync(new URL('sheets/classic.tsx', dir), 'utf8'),
    /^'use client';\nimport '\.\.\/classic\.css';\n/,
  );
  // Nothing the /@username route imports brings it in.
  for (const file of ['classic.tsx', 'style-page.tsx'])
    assert.doesNotMatch(
      readFileSync(new URL(file, dir), 'utf8'),
      /import '[^']*\.css'/,
      file,
    );
  // Classic keeps today's faces: Manrope and DM Serif from the root layout, money in Inter.
  assert.doesNotMatch(classicSheet, /@font-face|Studio /);
  assert.equal(STUDIO_STYLES.classic.displayFont, 'dm-serif-display');
});

const globalsCss = unguarded(
  readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
);
/** One declaration's value in a stylesheet's rule (first match), whitespace collapsed. */
const declOf = (css, selector, prop) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} in the stylesheet`);
  const body = css.slice(at, css.indexOf('}', at));
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(body);
  assert.ok(m, `${selector} { ${prop} }`);
  return m[1].replace(/\s+/g, ' ').trim();
};
const rem = (v) => Number(/^([\d.]+)rem$/.exec(v)?.[1]) * 16;
const SPACE = { 'var(--space-4)': 16, 'var(--space-10)': 40 };

test('the design check’s Classic slot widths are what classic.css draws on today’s page, and sizes follows them', () => {
  // Today's layout (globals.css), read rather than retyped.
  const sheet = declOf(globalsCss, '.profile-sheet', 'width');
  const [, sheetMax, sheetGutter] =
    /^min\(([\d.]+)rem, calc\(100% - ([\d.]+)rem\)\)$/.exec(sheet);
  const columns = declOf(
    globalsCss,
    '.profile-columns',
    'grid-template-columns',
  );
  const [, rail] = /^minmax\(0, 1fr\) ([\d.]+)rem$/.exec(columns);
  const gap = declOf(globalsCss, '.profile-columns', 'column-gap');
  const [, gapMin, gapVw, gapMax] =
    /^clamp\(([\d.]+)rem, ([\d.]+)vw, ([\d.]+)rem\)$/.exec(gap);
  const phone = globalsCss.slice(
    globalsCss.indexOf(
      '@media (max-width: 860px) {\n  body:has(.profile-page) .nav-shell',
    ),
  );
  const phoneMax = rem(declOf(phone, '.profile-columns', 'max-width'));
  const phoneGutter =
    SPACE[declOf(phone, '.profile-columns', 'padding-inline')];
  // Classic's own: the blocks' inset beside the rail, the strip's columns and gap.
  const desktop = classicSheet.slice(
    classicSheet.indexOf('@media (min-width: 861px)'),
  );
  const inset = SPACE[declOf(desktop, '.classic-blocks', 'padding-left')];
  const stripCols = Number(
    /^repeat\((\d+),/.exec(
      declOf(classicSheet, '.studio-strip', 'grid-template-columns'),
    )[1],
  );
  const stripGap = rem(declOf(classicSheet, '.studio-strip', 'gap'));
  assert.deepEqual([phoneGutter, inset, stripCols, stripGap], [16, 40, 2, 8]);
  const drawn = (v) => {
    const col =
      v >= 861
        ? Math.min(Number(sheetMax) * 16, v - Number(sheetGutter) * 16) -
          Number(rail) * 16 -
          Math.min(
            Math.max(Number(gapMin) * 16, (Number(gapVw) / 100) * v),
            Number(gapMax) * 16,
          ) -
          inset
        : Math.min(v, phoneMax) - 2 * phoneGutter;
    return { block: col, tile: (col - (stripCols - 1) * stripGap) / stripCols };
  };
  for (const v of [
    320, 390, 575, 576, 768, 860, 861, 1023, 1024, 1200, 1300, 1440,
  ]) {
    const { block, tile } = drawn(v);
    for (const kind of ['text', 'photo', 'video', 'services', 'events'])
      assert.equal(
        studioSlotWidth('classic', kind, v),
        Math.round(block),
        `${kind} at ${v}`,
      );
    assert.equal(
      studioSlotWidth('classic', 'gallery', v),
      Math.round(tile),
      `gallery at ${v}`,
    );
  }
  // The rendered photos ask for at least what is drawn at every width: the widest desktop
  // width (1200), the widest of 861–1023, 544 from 576, and the phone column as a calc.
  const html = page({ accent: 'green' });
  const sizes = /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.equal(
    sizes,
    `(min-width: 1024px) ${studioSlotWidth('classic', 'gallery', 1200)}px, (min-width: 861px) ${studioSlotWidth('classic', 'gallery', 1023)}px, (min-width: 576px) ${studioSlotWidth('classic', 'gallery', 576)}px, calc(50vw - 20px)`,
  );
  for (const v of [320, 390, 575])
    assert.equal(
      Math.round(v / 2 - 20),
      studioSlotWidth('classic', 'gallery', v),
      `${v}`,
    );
  for (let v = 1024; v <= 1440; v += 8)
    assert.ok(
      studioSlotWidth('classic', 'gallery', 1200) >= drawn(v).tile - 0.5,
      `${v}`,
    );
  for (let v = 861; v <= 1023; v += 2)
    assert.ok(
      studioSlotWidth('classic', 'gallery', 1023) >= drawn(v).tile - 0.5,
      `${v}`,
    );
});

test('the design check measures Classic’s section titles at the size classic.css draws', () => {
  const font = declOf(classicSheet, '.studio-title', 'font');
  const [, size] = /^400 ([\d.]+rem) \/ /.exec(font);
  assert.equal(STUDIO_HEADING_PX.classic, rem(size));
  // One size at every width: no media query restyles it.
  assert.equal(classicSheet.split('.studio-title {').length - 1, 1);
});

test('an all-default Classic document renders exactly the standard page', () => {
  const p = props(doc({ blocks: [] }));
  const styled = renderToStaticMarkup(
    renderStyled({
      ...p,
      lead: createElement('i', { 'data-part': 'tracker' }),
    }),
  );
  const standard = renderToStaticMarkup(
    createElement(StandardProfile, {
      firstName: 'Kemi',
      lead: createElement('i', { 'data-part': 'tracker' }),
      cover: p.coverArt,
      identity: p.identity,
      tipBlock: p.tipBlock,
      footer: p.footer,
    }),
  );
  assert.equal(styled, standard);
  assert.doesNotMatch(styled, /profile-page--studio|<style>|data-sheet/);
  // Any one choice is no longer the default.
  for (const over of [
    { accent: 'green' },
    { mode: 'dark' },
    { mode: 'auto' },
    { cover: 'plain' },
    {},
  ])
    assert.match(
      renderToStaticMarkup(renderStyled(props(doc(over)))),
      /profile-page--studio/,
      JSON.stringify(over),
    );
});

test('dark Classic turns off the featured link’s and the remember box’s shadows too', () => {
  const S = '.profile-page--studio[data-style="classic"][data-mode]';
  const want = [
    [`${S} .profile-links__featured`, 'shFeat', '.profile-links__featured'],
    [
      `${S} .profile-links__featured:active`,
      'shFeatDown',
      '.profile-links__featured:active',
    ],
    [
      `${S} .tip-remember input`,
      'shBox',
      '.profile-composer .tip-remember input',
    ],
  ];
  const norm = (v) =>
    v
      .replace(
        /rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/g,
        (_, r, g, b, a) => `rgba(${r},${g},${b},${Number(a) / 100})`,
      )
      .replace(
        /rgba\((\d+),(\d+),(\d+),\.(\d+)\)/g,
        (_, r, g, b, a) => `rgba(${r},${g},${b},${Number(`0.${a}`)})`,
      );
  const light = classicTokens(
    studioTokens('classic', null).light,
    'light',
    true,
  );
  const dark = classicTokens(
    studioTokens('classic', 'green').dark,
    'dark',
    false,
  );
  for (const [selector, token, today] of want) {
    const rule = rules(classicSheet).find((r) => r.selector === selector);
    assert.ok(rule, selector);
    assert.ok(
      rule.decls.some(
        ([p, v]) => p === 'box-shadow' && v === `var(--studio-${token})`,
      ),
      `${selector} uses --studio-${token}`,
    );
    // Light keeps today's shadow; dark has none.
    assert.equal(
      norm(light[token]),
      norm(declOf(globalsCss, today, 'box-shadow')),
      token,
    );
    assert.equal(dark[token], '0 0 0 transparent', token);
  }
});
