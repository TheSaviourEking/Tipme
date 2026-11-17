import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_FONTS,
  STUDIO_STYLE_IDS,
  contrastRatio,
  resolveStudio,
  studioSlotWidth,
  studioTokens,
} from '@tipme/contracts';

// Page Studio styles, PR 2a (spec 2026-11-17-page-studio-styles §8, §9.2, §13): the style frame
// as the server renders it. The components are TSX with `@/` imports, so each file is transpiled
// into a cache folder inside the app, its app imports pointed at small stand-ins (the avatar, the
// Pro badge, the link badge, money, the video island and the stylesheet loader are tested where
// they live). The frame's own markup, tokens and fonts are what these tests read.
const src = new URL('../src/components/studio-styles/', import.meta.url);
const out = new URL(
  '../node_modules/.cache/studio-style-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });

const STUBS = {
  '@/components/avatar': './stub-avatar.mjs',
  '@tipme/ui': './stub-ui.mjs',
  '@/components/profile/link-badge': './stub-link-badge.mjs',
  '@/components/money': './stub-money.mjs',
  '@/lib/avatar-source': './stub-avatar-source.mjs',
  './video-embed': './stub-video.mjs',
  './style-sheets': './stub-sheets.mjs',
  './parts': './parts.mjs',
  './style-fonts': './style-fonts.mjs',
  './style-tokens': './style-tokens.mjs',
};
function build(name, from) {
  const file = new URL(from, src);
  assert.ok(existsSync(file), `${from} exists`);
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
  'stub-avatar.mjs',
  `import { createElement } from 'react';
export const AvatarImage = (p) => createElement('img', { className: p.className, alt: p.name, src: p.src });`,
);
stub(
  'stub-ui.mjs',
  `import { createElement } from 'react';
export const ProBadge = (p) => createElement('span', { className: p.className }, 'Pro');`,
);
stub(
  'stub-link-badge.mjs',
  `import { createElement } from 'react';
export const LinkBadge = () => createElement('span', { 'aria-hidden': 'true', className: 'link-badge' });`,
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
build('style-tokens.mjs', 'style-tokens.ts');
build('style-fonts.mjs', 'style-fonts.ts');
build('parts.mjs', 'parts.tsx');
build('style-page.mjs', 'style-page.tsx');
const { StudioStylePage } = await import(new URL('style-page.mjs', out));

const IMG = '00000001-0000-4000-8000-000000000000';
const LINKS = [
  { platform: 'instagram', url: 'https://www.instagram.com/kemisings' },
  { platform: 'tiktok', url: 'https://www.tiktok.com/@kemisings' },
];
const doc = (over = {}) =>
  resolveStudio(
    {
      v: 2,
      style: 'clear',
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
        { id: 'quote001', kind: 'quote', text: 'Sing it again.' },
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
const page = ({ document = doc(), profile = {} } = {}) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
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
        role: 'Singer, Lagos',
        bio: 'I write songs about home.',
        links: LINKS,
        plan: 'pro',
        ...profile,
      },
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
const rootTag = (html) => /<div class="studio"[^>]*>/.exec(html)?.[0] ?? '';

test('the root carries data-style, data-mode and only --studio-* tokens', () => {
  for (const mode of ['light', 'dark', 'auto']) {
    const html = page({ document: doc({ mode }) });
    const root = rootTag(html);
    assert.match(root, /data-style="clear"/, mode);
    assert.match(root, new RegExp(`data-mode="${mode}"`), mode);
    const style = / style="([^"]*)"/.exec(root)?.[1] ?? '';
    const declarations = style.split(';').filter(Boolean);
    assert.ok(declarations.length > 8, `${mode}: tokens on the root`);
    for (const d of declarations)
      assert.match(d, /^--studio-[a-zA-Z0-9]+:[^;]+$/, `${mode}: ${d}`);
  }
  // Light (and auto, before the media query) carry the light values; dark the dark ones.
  const tokens = studioTokens('clear', null);
  assert.match(rootTag(page()), new RegExp(`--studio-bg:${tokens.light.bg}`));
  assert.match(
    rootTag(page({ document: doc({ mode: 'dark' }) })),
    new RegExp(`--studio-bg:${tokens.dark.bg}`),
  );
  assert.match(
    rootTag(page({ document: doc({ accent: 'coral' }) })),
    /--studio-acc:#c4362b/,
  );
});

test('auto emits the dark tokens only inside prefers-color-scheme', () => {
  const dark = studioTokens('clear', null).dark;
  const html = page({ document: doc({ mode: 'auto' }) });
  const media =
    /@media \(prefers-color-scheme: ?dark\)\s*\{([\s\S]*?\})\s*\}/.exec(html);
  assert.ok(media, 'a prefers-color-scheme block');
  assert.match(media[1], /\.studio\[data-mode="?auto"?\]/);
  for (const [key, value] of Object.entries(dark))
    assert.ok(media[1].includes(`--studio-${key}:${value}`), key);
  // Outside that block no dark-only value appears; light and dark pages have no such block.
  const rest = html.replace(media[0], '');
  assert.ok(!rest.includes(`--studio-thumb:${dark.thumb}`));
  for (const mode of ['light', 'dark'])
    assert.doesNotMatch(
      page({ document: doc({ mode }) }),
      /prefers-color-scheme/,
      mode,
    );
});

test('the skeleton is cover, identity, Tip, links, blocks, footer, in that order', () => {
  const html = page();
  const at = (marker) => {
    const i = html.indexOf(marker);
    assert.ok(i >= 0, `${marker} is on the page`);
    return i;
  };
  const order = [
    at('class="studio-cover'),
    at('class="studio-identity'),
    at('id="the-tip"'),
    at('class="studio-links"'),
    at('class="studio-blocks'),
    at('id="the-foot"'),
  ];
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  // The identity: one h1 with the name, the meta line, the bio.
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(
    html,
    /<h1[^>]*class="studio-name[^"]*"[^>]*>Kemi Adeyinka<\/h1>/,
  );
  assert.match(html, /@studiolab/);
  assert.match(html, /I write songs about home\./);
  // The style's own stylesheet loader, and the cover art when the cover is not a photo.
  assert.match(html, /data-sheet="clear"/);
  assert.match(html, /id="the-art"/);
});

test('links render once with the title "Find me elsewhere", and not at all without links', () => {
  const html = page();
  assert.equal(html.match(/Find me elsewhere/g)?.length, 1);
  assert.equal(html.match(/class="studio-links"/g)?.length, 1);
  for (const link of LINKS)
    assert.equal(html.split(`href="${link.url}"`).length - 1, 1, link.url);
  assert.match(html, /rel="noopener noreferrer nofollow ugc"/);
  const none = page({ profile: { links: [] } });
  assert.doesNotMatch(none, /Find me elsewhere|class="studio-links"/);
});

test('a page emits @font-face only for Inter and its own face, and preloads only the name face', () => {
  const families = (html) =>
    [...html.matchAll(/font-family:\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((f) => !f.endsWith(' Fallback'));
  const preloads = (html) =>
    [...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*>/g)]
      .filter((m) => /as="font"/.test(m[0]))
      .map((m) => m[1]);
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  // Clear is Inter only: one family, one file, preloaded (it sets the name).
  const clear = page();
  assert.deepEqual([...new Set(families(clear))], ['Studio Inter']);
  assert.deepEqual(preloads(clear), [inter.files[0].path]);
  // Journal adds Source Serif 4 for the name and titles; only its upright file is preloaded.
  const serif = STUDIO_FONTS.find((f) => f.id === 'source-serif-4');
  const journal = page({ document: doc({ style: 'journal' }) });
  assert.deepEqual([...new Set(families(journal))].sort(), [
    'Studio Inter',
    'Studio Source Serif 4',
  ]);
  assert.deepEqual(preloads(journal), [serif.files[0].path]);
  // At most 2 families, 4 files and 200 KB (§4.3), all from our origin.
  for (const html of [clear, journal]) {
    const files = [...html.matchAll(/src:\s*url\('([^']+)'\)/g)].map(
      (m) => m[1],
    );
    assert.ok(files.length <= 4);
    assert.ok(files.every((f) => f.startsWith('/fonts/studio/')));
    const bytes = STUDIO_FONTS.flatMap((f) => f.files)
      .filter((f) => files.includes(f.path))
      .reduce((sum, f) => sum + f.bytes, 0);
    assert.ok(bytes <= 200 * 1024, `${bytes} bytes of fonts`);
  }
});

test("a name the face can't draw is set wholly in Inter", () => {
  // Source Serif 4 has no ɓ ɗ ƙ ƴ (§9.10): the whole name is Inter, never a letter-by-letter mix.
  const name = 'Ɗanlami Ƙwairanga Ɓello';
  const html = page({
    document: doc({ style: 'journal' }),
    profile: { displayName: name },
  });
  const h1 = /<h1[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(h1, /class="studio-name studio-name--fallback"/);
  // One font-family for the whole element (CSS), no inline face and no per-letter spans.
  assert.doesNotMatch(h1, /style=/);
  assert.match(html, new RegExp(`<h1[^>]*>${name}</h1>`));
  // The display face is then not preloaded: Inter sets the name.
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  assert.match(
    html,
    new RegExp(`<link rel="preload" href="${inter.files[0].path}"`),
  );
  // A name the face draws keeps it.
  const drawn = page({
    document: doc({ style: 'journal' }),
    profile: { displayName: 'Ẹniọlá Bámidélé' },
  });
  assert.match(/<h1[^>]*>/.exec(drawn)?.[0] ?? '', /class="studio-name"/);
});

test("the design check's photo slots are the widths Clear's CSS draws, and sizes follows them", () => {
  const css = readFileSync(new URL('clear.css', src), 'utf8');
  // Phone and tablet: the strip's fixed tile width.
  const strip = /\.studio-strip li \{[^}]*?width: (\d+)px/.exec(css);
  assert.ok(strip, 'the strip tile width in clear.css');
  const tile = Number(strip[1]);
  for (const v of [320, 390, 768, 1023])
    assert.equal(studioSlotWidth('clear', 'gallery', v), tile, `${v}px`);
  // Desktop: a 3-up grid with the strip's gap, inside the column a photo block fills.
  const columns =
    /\.studio-strip \{[^}]*grid-template-columns: repeat\((\d+),/.exec(css);
  const gap = /\.studio-strip \{[^}]*?gap: (\d+)px/.exec(css);
  assert.ok(columns && gap, 'the desktop grid and gap in clear.css');
  const column = studioSlotWidth('clear', 'photo', 1440);
  const n = Number(columns[1]);
  assert.equal(
    studioSlotWidth('clear', 'gallery', 1440),
    Math.round((column - (n - 1) * Number(gap[1])) / n),
  );
  // The rendered photos ask for exactly those widths.
  const html = page();
  const sizes = /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.equal(
    sizes,
    `(min-width: 1024px) ${studioSlotWidth('clear', 'gallery', 1440)}px, (min-width: 768px) ${tile}px, ${tile}px`,
  );
});

// The site's header and footer on a styled page take the page's own neutrals (owner, ruling P):
// the page writes them on <html> from the registry, so the chrome can never drift from it.
const CHROME_KEYS = ['bg', 'card', 'el2', 'fg', 'fg2', 'line'];
const chromeBlocks = (html) =>
  [
    ...html.matchAll(
      /(@media \(prefers-color-scheme: ?dark\)\{)?html:has\(\.studio\[data-style\]\)\{([^}]*)\}/g,
    ),
  ].map((m) => ({
    media: Boolean(m[1]),
    tokens: Object.fromEntries(
      [...m[2].matchAll(/--studio-([a-zA-Z0-9]+):([^;!]+)/g)].map((d) => [
        d[1],
        d[2].trim(),
      ]),
    ),
  }));

test("the site's header and footer get the page's neutrals from the registry, per mode", () => {
  const tokens = studioTokens('clear', 'coral');
  const pick = (t) => Object.fromEntries(CHROME_KEYS.map((k) => [k, t[k]]));
  for (const mode of ['light', 'dark']) {
    const blocks = chromeBlocks(
      page({ document: doc({ mode, accent: 'coral' }) }),
    );
    assert.deepEqual(
      blocks,
      [{ media: false, tokens: pick(tokens[mode]) }],
      mode,
    );
  }
  // Auto: light, then dark inside prefers-color-scheme (pure CSS).
  assert.deepEqual(chromeBlocks(page({ document: doc({ mode: 'auto' }) })), [
    { media: false, tokens: pick(studioTokens('clear', null).light) },
    { media: true, tokens: pick(studioTokens('clear', null).dark) },
  ]);
  // Neutrals only: the accent never reaches the site's chrome.
  for (const { tokens: t } of chromeBlocks(page()))
    assert.ok(!('acc' in t) && !('accText' in t));
});

test("text on the site's chrome keeps 4.5:1 in every style, light and dark", () => {
  for (const style of STUDIO_STYLE_IDS.filter((s) => s !== 'classic'))
    for (const mode of ['light', 'dark']) {
      const t = studioTokens(style, null)[mode];
      // Header and footer links on the page; footer card text; Sign in on the raised surface.
      for (const [fg, bg, name] of [
        [t.fg, t.bg, 'fg on bg'],
        [t.fg2, t.bg, 'fg2 on bg'],
        [t.fg, t.card, 'fg on card'],
        [t.fg2, t.card, 'fg2 on card'],
      ])
        assert.ok(
          contrastRatio(fg, bg) >= 4.5,
          `${style} ${mode}: ${name} ${contrastRatio(fg, bg).toFixed(2)}`,
        );
    }
});
