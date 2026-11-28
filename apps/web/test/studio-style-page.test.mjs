import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { unguarded } from './shown-page.mjs';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_FONTS,
  STUDIO_HEADING_PX,
  STUDIO_STYLE_IDS,
  STUDIO_ACCENT_IDS,
  STUDIO_TILES_RING_MIX,
  blend,
  checkDesign,
  contrastRatio,
  hexToOklch,
  oklchToHex,
  pickPhotoAccent,
  resolveCover,
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
  // Classic is tested in studio-classic.test.mjs.
  './classic': './stub-classic.mjs',
  '@/components/profile/standard-profile': './stub-standard-profile.mjs',
  '@/components/brand': './stub-brand.mjs',
  'next/link': './stub-link.mjs',
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
stub(
  'stub-brand.mjs',
  `import { createElement } from 'react';
export const Wordmark = (p) => createElement('span', { className: p.className ? 'wordmark ' + p.className : 'wordmark', 'aria-hidden': true });`,
);
stub(
  'stub-link.mjs',
  `import { createElement } from 'react';
export default ({ prefetch, ...p }) => createElement('a', { ...p, 'data-prefetch': String(prefetch) });`,
);
stub('stub-classic.mjs', 'export const ClassicStudio = () => null;');
stub('stub-standard-profile.mjs', 'export const StandardProfile = () => null;');
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

// Journal and Linen (PR 2c, spec §9.3, §9.8).
const sheet = (style) =>
  unguarded(readFileSync(new URL(`${style}.css`, src), 'utf8'));
/** The declarations of the first rule whose selector ends with `selector` (outside media). */
const declarations = (css, selector, media = null) => {
  const body = media
    ? (new RegExp(`@media \\(${media}\\) \\{([\\s\\S]*?)\\n\\}`).exec(
        css,
      )?.[1] ?? '')
    : css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Selectors as Prettier wraps them: compare with runs of whitespace as one space.
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const rule = new RegExp(`(?:^|\\}) ?${escaped} \\{([^}]*)\\}`).exec(flat);
  assert.ok(rule, `${selector}${media ? ` in ${media}` : ''}`);
  return rule[1];
};
const px = (decls, prop) => {
  const m = new RegExp(`(?:^|[;\\s])${prop}: (\\d+)px`).exec(decls);
  assert.ok(m, `${prop} in ${decls}`);
  return Number(m[1]);
};

test("the design check measures Journal's and Linen's section titles at the size their CSS draws", () => {
  for (const style of ['journal', 'linen']) {
    const title = declarations(
      sheet(style),
      `.studio[data-style='${style}'] .studio-title`,
    );
    assert.equal(STUDIO_HEADING_PX[style], px(title, 'font-size'), style);
  }
});

test("the design check's photo slots are the widths Journal's CSS draws, and sizes follows them", () => {
  const css = sheet('journal');
  // Phone: one column with 20 px gutters; tablet 24 px gutters up to 720.
  assert.equal(
    px(declarations(css, ".studio[data-style='journal']"), '--gutter'),
    20,
  );
  const tablet = declarations(
    css,
    ".studio[data-style='journal']",
    'min-width: 768px',
  );
  assert.equal(px(tablet, '--gutter'), 24);
  assert.equal(px(tablet, '--measure'), 720);
  // The 3-up grid and its gap.
  const strip = declarations(
    css,
    ".studio[data-style='journal'] .studio-strip",
  );
  const n = Number(/grid-template-columns: repeat\((\d+),/.exec(strip)[1]);
  const gap = px(strip, 'gap');
  for (const v of [320, 390])
    assert.equal(
      studioSlotWidth('journal', 'gallery', v),
      Math.round((v - 40 - (n - 1) * gap) / n),
      `${v}px`,
    );
  assert.equal(
    studioSlotWidth('journal', 'gallery', 800),
    Math.round((720 - (n - 1) * gap) / n),
  );
  // Desktop: content 1120, a 420 px column, gap 96; every block in the right column (Ruling U),
  // text and quotes at most 520, a gallery 3-up. Every kind a block can be is checked.
  const desk = declarations(
    css,
    ".studio[data-style='journal']",
    'min-width: 1024px',
  );
  const content = px(desk, '--measure');
  const split = declarations(
    css,
    ".studio[data-style='journal'] .studio-page",
    'min-width: 1024px',
  );
  const left = Number(/grid-template-columns: (\d+)px/.exec(split)[1]);
  const colGap = px(split, 'column-gap');
  const rest = content - left - colGap;
  const blocks = declarations(
    css,
    ".studio[data-style='journal'] .studio-blocks",
    'min-width: 1024px',
  );
  assert.match(blocks, /grid-column: 2/, 'the blocks take the right column');
  const capped = px(
    declarations(
      css,
      ".studio[data-style='journal'] .studio-blocks :is(.studio-text, .studio-quote)",
      'min-width: 1024px',
    ),
    'max-width',
  );
  const drawn = {
    text: capped,
    quote: capped,
    photo: rest,
    video: rest,
    services: rest,
    events: rest,
    supporters: rest,
    gallery: Math.round((rest - (n - 1) * gap) / n),
  };
  for (const [kind, width] of Object.entries(drawn))
    assert.equal(studioSlotWidth('journal', kind, 1440), width, kind);
  // No section or block is pulled back into the left column.
  assert.doesNotMatch(css, /blocks__rest|\.studio-blocks > \.studio-section/);
  // The rendered photos ask for exactly those widths.
  const html = page({ document: doc({ style: 'journal' }) });
  const sizes = /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.equal(
    sizes,
    `(min-width: 1024px) ${studioSlotWidth('journal', 'gallery', 1440)}px, (min-width: 768px) ${studioSlotWidth('journal', 'gallery', 1023)}px, ${studioSlotWidth('journal', 'gallery', 390)}px`,
  );
});

test("the design check's photo slots are the widths Linen's CSS draws, and sizes follows them", () => {
  const css = sheet('linen');
  assert.equal(
    px(declarations(css, ".studio[data-style='linen']"), '--gutter'),
    20,
  );
  const tablet = declarations(
    css,
    ".studio[data-style='linen']",
    'min-width: 768px',
  );
  assert.equal(px(tablet, '--gutter'), 24);
  assert.equal(px(tablet, '--measure'), 720);
  // Photos: 3fr / 2fr, gap 8; the check takes the larger photo.
  const strip = declarations(css, ".studio[data-style='linen'] .studio-strip");
  assert.match(strip, /grid-template-columns: 3fr 2fr/);
  const gap = px(strip, 'gap');
  for (const v of [320, 390])
    assert.equal(
      studioSlotWidth('linen', 'gallery', v),
      Math.round(((v - 40 - gap) * 3) / 5),
      `${v}px`,
    );
  // Desktop: content 1120, the blocks in a 600 px column beside the rest, gap 72.
  const desk = declarations(
    css,
    ".studio[data-style='linen']",
    'min-width: 1024px',
  );
  assert.equal(px(desk, '--measure'), 1120);
  const blocks = declarations(
    css,
    ".studio[data-style='linen'] .studio-blocks",
    'min-width: 1024px',
  );
  const column = Number(
    /grid-template-columns: minmax\(0, (\d+)px\)/.exec(blocks)[1],
  );
  for (const kind of ['text', 'photo', 'services'])
    assert.equal(studioSlotWidth('linen', kind, 1440), column, kind);
  assert.equal(
    studioSlotWidth('linen', 'gallery', 1440),
    Math.round(((column - gap) * 3) / 5),
  );
  const html = page({ document: doc({ style: 'linen' }) });
  const sizes = /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.equal(
    sizes,
    `(min-width: 1024px) ${studioSlotWidth('linen', 'gallery', 1440)}px, (min-width: 768px) ${studioSlotWidth('linen', 'gallery', 1023)}px, ${studioSlotWidth('linen', 'gallery', 390)}px`,
  );
});

test('Linen emits Inter and its three Linen Serif files, at most 4 files and 200 KB, and preloads only the name face', () => {
  const html = page({ document: doc({ style: 'linen' }) });
  const files = [...html.matchAll(/src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
  const linen = STUDIO_FONTS.find((f) => f.id === 'linen-serif');
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  assert.deepEqual(
    files.sort(),
    [...inter.files, ...linen.files].map((f) => f.path).sort(),
  );
  assert.ok(files.length <= 4);
  const bytes = [...inter.files, ...linen.files].reduce(
    (s, f) => s + f.bytes,
    0,
  );
  assert.ok(bytes <= 200 * 1024, `${bytes} bytes`);
  assert.match(html, /font-family:'Studio Linen Serif'/);
  const preloads = [
    ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g),
  ].map((m) => m[1]);
  assert.deepEqual(preloads, ['/fonts/studio/linen-serif-400.woff2']);
});

test("Journal opens on its top row: the role as the label, the avatar, and the handle for a desktop's right side", () => {
  const html = page({ document: doc({ style: 'journal', cover: 'plain' }) });
  const top = /<div class="studio-top">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(top, 'a top row');
  assert.match(top[1], /<p class="studio-kicker">Singer, Lagos<\/p>/);
  assert.match(top[1], /class="studio-avatar studio-avatar--top"/);
  assert.match(top[1], /<p class="studio-top__handle">@studiolab<\/p>/);
  // Before the cover and the identity; the identity keeps its own (desktop) avatar.
  assert.ok(
    html.indexOf('class="studio-top"') < html.indexOf('class="studio-cover'),
  );
  assert.match(
    html,
    /<header class="studio-identity"[\s\S]*?class="studio-avatar"/,
  );
  // No top row on the other styles.
  assert.doesNotMatch(page(), /studio-top/);
});

test("Journal's phone bar carries the name and handle beside the Tip, out of the accessibility tree", () => {
  const html = page({ document: doc({ style: 'journal' }) });
  assert.match(
    html,
    /<div class="studio-barname" aria-hidden="true"><p class="studio-barname__name" data-truncate="">Kemi Adeyinka<\/p><p class="studio-barname__handle" data-truncate="">@studiolab<\/p><\/div>/,
  );
  // A Hausa name is set wholly in Inter there too.
  const hausa = page({
    document: doc({ style: 'journal' }),
    profile: { displayName: 'Ɗanlami Ƙwairanga Ɓello' },
  });
  assert.match(
    hausa,
    /class="studio-barname__name studio-barname__name--fallback"/,
  );
  assert.doesNotMatch(page(), /studio-barname/);
});

test('Linen titles its Tip card "Send a tip"', () => {
  const html = page({ document: doc({ style: 'linen' }) });
  assert.match(
    html,
    /<section class="studio-tip"[^>]*><h2 class="studio-tip__title">Send a tip<\/h2><form id="the-tip"/,
  );
  assert.doesNotMatch(page(), /Send a tip/);
});

// Stage and Horizon (PR 2d, spec §9.4, §9.9, §13): the identity over a full-bleed cover photo.
const LAB_COVER = { kind: 'photo', path: `/dev/studio-lab/image/${IMG}` };
const over = (style, { cover = 'yours', mode, profile = {}, coverSize } = {}) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
      studio: {
        document: doc({ style, cover, ...(mode ? { mode } : {}) }),
        images: {},
        palette: studioTokens(style, null),
        checkVersion: DESIGN_CHECK_VERSION,
      },
      profile: {
        handle: 'studiolab',
        displayName: 'Kemi Adeyinka',
        role: 'Singer, Lagos',
        bio: 'I write songs about home.',
        links: LINKS,
        plan: 'pro',
        cover: LAB_COVER,
        ...profile,
      },
      ...(coverSize ? { coverSize } : {}),
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
const { STYLE_COVER } = await import(new URL('parts.mjs', out));
/** The site header's height (globals.css), which a cover runs up under on a styled page. */
const NAV_HEIGHT = Number(
  /--nav-height: (\d+)px;/.exec(
    readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
  )[1],
);

/** A CSS linear-gradient's stops as [alpha, position 0..1], from the bottom (`to top`). */
function scrimStops(decls, scrimEnd) {
  const g = /linear-gradient\(\s*to top,([\s\S]*?)\);/.exec(decls);
  assert.ok(g, `a to-top gradient in ${decls}`);
  const parts = g[1].split(/,(?![^(]*\))/).map((p) => p.trim());
  return parts.map((part, i) => {
    const pos = /(\d+(?:\.\d+)?)%$/.exec(part);
    const at = pos ? Number(pos[1]) / 100 : i === parts.length - 1 ? 1 : 0;
    if (/^transparent/.test(part)) return [0, at];
    if (/var\(--studio-scrimEnd\)/.test(part)) return [scrimEnd, at];
    const rgba = /rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)/.exec(part);
    assert.ok(rgba, part);
    return [Number(rgba[1]), at];
  });
}
const alphaAt = (stops, f) => {
  for (let i = 1; i < stops.length; i += 1) {
    const [a0, p0] = stops[i - 1];
    const [a1, p1] = stops[i];
    if (f <= p1) return a0 + ((a1 - a0) * (f - p0)) / (p1 - p0 || 1);
  }
  return stops.at(-1)[0];
};
const scrimAlpha = (value) =>
  value.startsWith('#') ? 1 : Number(/,\s*([\d.]+)\)$/.exec(value)[1]);

test("text over a Stage or Horizon photo sits on the spec's scrim: at least 55% black wherever text sits", () => {
  const spec = {
    // §9.4: lower 75%; scrimEnd 0%, .8 12%, .66 38%, .3 68%, transparent.
    stage: {
      lower: 0.75,
      alphas: [null, 0.8, 0.66, 0.3, 0],
      at: [0, 0.12, 0.38, 0.68, 1],
    },
    // §9.9: lower 70%; .7 0%, .62 45%, .3 72%, transparent.
    horizon: {
      lower: 0.7,
      alphas: [0.7, 0.62, 0.3, 0],
      at: [0, 0.45, 0.72, 1],
    },
  };
  for (const [style, want] of Object.entries(spec)) {
    const css = sheet(style);
    const scrim = declarations(
      css,
      `.studio[data-style='${style}'] .studio-scrim::before`,
    );
    // The scrim's least alpha at its 0% stop (Stage's scrimEnd is .86 light, opaque dark).
    const ends = ['light', 'dark'].map((m) =>
      scrimAlpha(studioTokens(style, null)[m].scrimEnd ?? 'rgba(0,0,0,1)'),
    );
    const stops = scrimStops(scrim, Math.min(...ends));
    assert.deepEqual(
      stops.map(([, at]) => at),
      want.at,
      `${style} stop positions`,
    );
    want.alphas.forEach((a, i) => {
      if (a !== null) assert.equal(stops[i][0], a, `${style} stop ${i}`);
    });
    // Its height: the spec's share of the cover, or more when the words are taller (a long name),
    // so the top of the words is never above the point where the scrim reaches 55%.
    const height =
      /height: max\(calc\(var\(--tall\) \* ([\d.]+)\), (\d+)%\)/.exec(scrim);
    assert.ok(height, `${style}: the scrim's height rule`);
    assert.equal(Number(height[1]), want.lower, `${style}: lower share`);
    const top = 100 / Number(height[2]);
    const least = alphaAt(stops, top);
    assert.ok(
      least >= 0.55,
      `${style}: ${least.toFixed(3)} black at the top of the words`,
    );
    // White text on that scrim over a white photo: 4.5:1 at the top, the worst place.
    const grey = Math.round(255 * (1 - least));
    const hex = `#${grey.toString(16).padStart(2, '0').repeat(3)}`;
    assert.ok(
      contrastRatio('#ffffff', hex) >= 4.5,
      `${style}: ${contrastRatio('#ffffff', hex)}`,
    );
    // The scrim spans the whole cover's width under the words; the words are white only.
    assert.match(scrim, /left: 0;/);
    assert.match(scrim, /right: 0;/);
    assert.match(scrim, /bottom: 0;/);
    const words = declarations(
      css,
      `.studio[data-style='${style}'] .studio-scrim`,
    );
    assert.match(words, /color: #fff;/, `${style}: white words`);
    // The cover's own height, plus the header it runs up under (frame.css), is the one
    // StyleCover sizes its photo for (phone, desktop).
    assert.equal(
      px(declarations(css, `.studio[data-style='${style}']`), '--tall') +
        NAV_HEIGHT,
      STYLE_COVER[style].tall,
    );
    assert.equal(
      px(
        declarations(
          css,
          `.studio[data-style='${style}']`,
          'min-width: 1024px',
        ),
        '--tall',
      ) + NAV_HEIGHT,
      STYLE_COVER[style].desktopTall,
    );
  }
  assert.deepEqual(STYLE_COVER.stage, { tall: 564, desktopTall: 716 });
  assert.deepEqual(STYLE_COVER.horizon, { tall: 716, desktopTall: 912 });
});

test('Stage and Horizon put the words over the photo, white, on the scrim, with no avatar', () => {
  for (const style of ['stage', 'horizon']) {
    const html = over(style);
    const hero =
      /<header class="studio-identity studio-hero"[^>]*data-cover="photo"[^>]*>([\s\S]*?)<\/header>/.exec(
        html,
      );
    assert.ok(hero, `${style}: the hero header`);
    assert.match(hero[1], /<div class="studio-cover" data-cover="photo">/);
    assert.match(hero[1], /<div class="studio-hero__words studio-scrim">/);
    assert.match(
      hero[1],
      /<h1 id="studio-name" class="studio-name">Kemi Adeyinka<\/h1>/,
    );
    assert.doesNotMatch(
      hero[1],
      /studio-avatar/,
      `${style}: no avatar over a photo`,
    );
    // The bio sits below the cover, with the Tip.
    assert.doesNotMatch(hero[1], /studio-bio/);
    assert.match(
      html,
      /<div class="studio-lead">[\s\S]*?<p class="studio-bio">I write songs about home\.<\/p>[\s\S]*?<form id="the-tip"/,
    );
    // The order: hero, lead (bio, Tip), links, blocks, footer.
    const at = (m) => html.indexOf(m);
    const order = [
      at('studio-hero'),
      at('class="studio-lead"'),
      at('id="the-tip"'),
      at('class="studio-links"'),
      at('class="studio-blocks'),
      at('id="the-foot"'),
    ];
    assert.ok(
      order.every((i) => i >= 0),
      `${style}: ${order}`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      style,
    );
  }
  // Stage's label over the photo is the role; Horizon has none.
  assert.match(over('stage'), /<p class="studio-kicker">Singer, Lagos<\/p>/);
  assert.doesNotMatch(over('horizon'), /studio-kicker/);
});

test('Stage and Horizon fall back to their gradient treatment when the cover is not a photo', () => {
  const covers = [
    { kind: 'design', design: 'scattered', colour: 'neutral' },
    { kind: 'design', design: 'dark' },
    { kind: 'animated', animation: 'drift', play: 'once' },
    undefined,
  ];
  for (const style of ['stage', 'horizon'])
    for (const cover of covers) {
      const html = over(style, { profile: { cover } });
      assert.match(
        html,
        /<header class="studio-identity studio-hero"[^>]*data-cover="gradient"/,
        `${style} ${cover?.kind}`,
      );
      assert.match(
        html,
        /<div class="studio-cover" data-cover="gradient" aria-hidden="true"><\/div>/,
      );
      // Not today's cover art, and no scrim or photo: the words are in the page's own colours.
      const m =
        /id="the-art"|class="[^"]*studio-scrim|studio-cover__photo/.exec(html);
      assert.equal(m, null, `${style} ${cover?.kind}: ${m?.[0]}`);
    }
  // Stage's plain cover has a 112 px avatar above the name; its gradient none. Horizon's gradient
  // and plain both centre a 96 px avatar on card.
  assert.match(
    over('stage', { cover: 'plain' }),
    /data-cover="plain"[\s\S]*?class="studio-avatar"[\s\S]*?<h1/,
  );
  const heroOf = (html) =>
    /<header class="studio-identity studio-hero"[\s\S]*?<\/header>/.exec(
      html,
    )?.[0] ?? '';
  assert.doesNotMatch(
    heroOf(over('stage', { cover: 'gradient' })),
    /studio-avatar/,
  );
  for (const cover of ['gradient', 'plain'])
    assert.match(
      over('horizon', { cover }),
      /studio-hero__words"><img class="studio-avatar"[\s\S]*?<h1/,
      cover,
    );
});

test('Horizon\'s two cover buttons: "Send a tip" goes to the Tip area, "See links" to the links, and is absent without links', () => {
  const html = over('horizon');
  assert.match(
    html,
    /<a class="studio-hero__tip" href="#studio-tip" data-tip-cta="">Send a tip<\/a>/,
  );
  // Only Horizon marks a Tip action for the phone bar to wait for.
  assert.doesNotMatch(over('stage'), /data-tip-cta/);
  assert.match(
    html,
    /<a class="studio-hero__links" href="#studio-links">See links<svg/,
  );
  // The targets: the Tip area takes focus (tabindex -1), the links section has the id.
  const tip = /<section class="studio-tip"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(tip, / id="studio-tip"/);
  assert.match(tip, / tabindex="-1"/i);
  assert.match(tip, / aria-label="Tip Kemi"/);
  // Only Horizon's Tip area takes focus from a link.
  assert.doesNotMatch(over('stage'), /id="studio-tip"/);
  assert.match(html, /<section class="studio-links" id="studio-links"/);
  const none = over('horizon', { profile: { links: [] } });
  assert.match(none, /Send a tip<\/a>/);
  assert.doesNotMatch(none, /See links|studio-links/);
  // On a gradient or plain cover the same two buttons, with "See links" outlined (CSS).
  assert.match(
    over('horizon', { cover: 'plain' }),
    /href="#studio-links">See links/,
  );
  // Stage has no cover buttons.
  assert.doesNotMatch(over('stage'), /studio-hero__tip|See links/);
});

test('the cover photo is cropped by the style: high priority, sized for its tall crop, never upscaled', () => {
  const img = (html) =>
    /<img class="studio-cover__photo"[^>]*>/.exec(html)?.[0] ?? '';
  for (const style of ['stage', 'horizon']) {
    const { tall, desktopTall } = STYLE_COVER[style];
    // A 16:9 rendition cropped to fill the slot is drawn 16/9 as wide as the slot is tall.
    const phone = Math.ceil((tall * 16) / 9);
    const desk = Math.ceil((desktopTall * 16) / 9);
    const tag = img(over(style, { coverSize: { width: 2400, height: 1600 } }));
    assert.match(tag, /fetchpriority="high"/i);
    assert.match(tag, /loading="eager"/);
    assert.match(
      tag,
      new RegExp(
        `sizes="\\(min-width: ${desk}px\\) 100vw, \\(min-width: 1024px\\) ${desk}px, \\(min-width: ${phone}px\\) 100vw, ${phone}px"`,
      ),
    );
    assert.match(
      tag,
      /srcset="[^"]*wide-480 480w, [^"]*wide-960 960w, [^"]*wide-1440 1440w"/i,
    );
    // A 640 × 360 photo is offered at 480 only: no rendition is wider than the photo.
    const small = img(over(style, { coverSize: { width: 640, height: 360 } }));
    assert.match(small, /srcset="[^"]*wide-480 480w"/i);
    assert.match(small, / src="[^"]*wide-480"/);
  }
  // The crop keeps the upper third (no focal point is stored for a Settings cover).
  const frame = unguarded(readFileSync(new URL('frame.css', src), 'utf8'));
  assert.match(
    declarations(frame, '.studio[data-style] .studio-cover__photo'),
    /object-position: 50% 33%;/,
  );
});

test("the design check measures Stage's and Horizon's section titles at the size their CSS draws, and their slots", () => {
  for (const style of ['stage', 'horizon'])
    assert.equal(
      STUDIO_HEADING_PX[style],
      px(
        declarations(
          sheet(style),
          `.studio[data-style='${style}'] .studio-title`,
        ),
        'font-size',
      ),
      style,
    );
  // Stage: a strip of fixed tiles below 1024; on a desktop a 400 rail, gap 80, the main column,
  // photos 3-up.
  const stage = sheet('stage');
  const tile = px(
    declarations(stage, ".studio[data-style='stage'] .studio-strip li"),
    'width',
  );
  for (const v of [320, 390, 768, 1023])
    assert.equal(studioSlotWidth('stage', 'gallery', v), tile, `${v}`);
  const desk = declarations(
    stage,
    ".studio[data-style='stage'] .studio-page",
    'min-width: 1024px',
  );
  const cols =
    /grid-template-columns:[^;]*minmax\(0, (\d+)px\) (\d+)px minmax\(0, (\d+)px\)/.exec(
      desk,
    );
  assert.ok(cols, `Stage's desktop columns in ${desk}`);
  assert.deepEqual(cols.slice(1).map(Number), [400, 80, 720]);
  const main = Number(cols[3]);
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('stage', kind, 1440), main, kind);
  const strip = declarations(
    stage,
    ".studio[data-style='stage'] .studio-strip",
    'min-width: 1024px',
  );
  const n = Number(/grid-template-columns: repeat\((\d+),/.exec(strip)[1]);
  assert.equal(
    studioSlotWidth('stage', 'gallery', 1440),
    Math.round((main - (n - 1) * px(strip, 'gap')) / n),
  );
  // Horizon: 3-up, gap 8 below 1024; on a desktop 440, gap 80, every block in the right column.
  const horizon = sheet('horizon');
  const hstrip = declarations(
    horizon,
    ".studio[data-style='horizon'] .studio-strip",
  );
  const hn = Number(/grid-template-columns: repeat\((\d+),/.exec(hstrip)[1]);
  const hgap = px(hstrip, 'gap');
  for (const v of [320, 390])
    assert.equal(
      studioSlotWidth('horizon', 'gallery', v),
      Math.round((v - 40 - (hn - 1) * hgap) / hn),
      `${v}`,
    );
  const hdesk = declarations(
    horizon,
    ".studio[data-style='horizon'] .studio-page",
    'min-width: 1024px',
  );
  const hcols =
    /grid-template-columns:[^;]*minmax\(0, (\d+)px\) (\d+)px minmax\(0, (\d+)px\)/.exec(
      hdesk,
    );
  assert.ok(hcols, `Horizon's desktop columns in ${hdesk}`);
  assert.deepEqual(hcols.slice(1).map(Number), [440, 80, 520]);
  const right = Number(hcols[3]);
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('horizon', kind, 1440), right, kind);
  const hdstrip = declarations(
    horizon,
    ".studio[data-style='horizon'] .studio-strip",
    'min-width: 1024px',
  );
  assert.equal(
    studioSlotWidth('horizon', 'gallery', 1440),
    Math.round((right - (hn - 1) * px(hdstrip, 'gap')) / hn),
  );
  // The rendered photos ask for those widths.
  for (const style of ['stage', 'horizon']) {
    const html = page({ document: doc({ style }) });
    const sizes = /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(
      html,
    )?.[1];
    assert.equal(
      sizes,
      `(min-width: 1024px) ${studioSlotWidth(style, 'gallery', 1440)}px, (min-width: 768px) ${studioSlotWidth(style, 'gallery', 1023)}px, ${studioSlotWidth(style, 'gallery', 390)}px`,
    );
  }
});

test("Stage's glow is dark only, the accent, and never costs the bio its contrast", () => {
  const css = sheet('stage');
  const glow = declarations(
    css,
    ".studio[data-style='stage'] .studio-hero::before",
  );
  assert.match(glow, /height: 260px;/);
  assert.match(
    glow,
    /radial-gradient\(\s*50% 50% at 50% 30%,\s*color-mix\(in srgb, var\(--studio-glow\) 28%, transparent\),\s*transparent\s*\)/,
  );
  assert.match(glow, /filter: blur\(10px\);/);
  // The registry: the accent's fill in dark, none in light (the rule then draws nothing).
  for (const accent of [null, 'ink', 'amber']) {
    const t = studioTokens('stage', accent);
    assert.equal(t.light.glow, 'none');
    assert.equal(t.dark.glow, t.dark.acc);
  }
  // Its centre sits 30% down its 260 px, `top` above the cover's foot; the bio starts the lead's
  // padding below that foot. There the glow is at most 28% × (1 − distance / 130), straight
  // falloff (a blur doesn't raise a straight ramp). fg2 on bg under it keeps 4.5:1 for every accent.
  const top = Number(/top: calc\(var\(--tall\) - (\d+)px\);/.exec(glow)?.[1]);
  assert.ok(top > 0, 'the glow is placed from the cover foot');
  const lead = px(
    declarations(css, ".studio[data-style='stage'] .studio-lead"),
    'padding-top',
  );
  const distance = lead + (top - 0.3 * 260);
  const strength = 0.28 * Math.max(0, 1 - distance / 130);
  const mix = (a, b, t) =>
    `#${[1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(a.slice(i, i + 2), 16) * t +
            parseInt(b.slice(i, i + 2), 16) * (1 - t),
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  for (const accent of [
    'ink',
    'blue',
    'lagoon',
    'green',
    'violet',
    'rose',
    'coral',
    'amber',
  ]) {
    const t = studioTokens('stage', accent).dark;
    const under = mix(t.acc, t.bg, strength);
    assert.ok(
      contrastRatio(t.fg2, under) >= 4.5,
      `${accent}: fg2 ${contrastRatio(t.fg2, under).toFixed(2)} on ${under}`,
    );
  }
});

test('Stage and Horizon set everything in Inter (Horizon 400 and 500 only), and preload Inter', () => {
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  for (const style of ['stage', 'horizon']) {
    const html = over(style);
    const families = [...html.matchAll(/font-family:\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((f) => !f.endsWith(' Fallback'));
    assert.deepEqual([...new Set(families)], ['Studio Inter'], style);
    const preloads = [
      ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g),
    ].map((m) => m[1]);
    assert.deepEqual(preloads, [inter.files[0].path], style);
    assert.doesNotMatch(
      sheet(style),
      /font-family: var\(--serif\)|'Studio (?!Inter)/,
      style,
    );
  }
  const weights = [
    ...sheet('horizon').matchAll(/font(?:-weight)?: (\d{3})/g),
  ].map((m) => Number(m[1]));
  assert.ok(weights.length > 0);
  assert.deepEqual([...new Set(weights)].sort(), [400, 500]);
});

test("Stage's phone bar carries the avatar, the name and the handle beside the Tip, out of the accessibility tree", () => {
  const html = over('stage');
  assert.match(
    html,
    /<div class="studio-barname" aria-hidden="true"><img class="studio-avatar studio-barname__avatar"[^>]*><p class="studio-barname__name" data-truncate="">Kemi Adeyinka<\/p><p class="studio-barname__handle" data-truncate="">@studiolab<\/p><\/div>/,
  );
  assert.doesNotMatch(over('horizon'), /studio-barname/);
});

// Fix round 1 (PR 2d review).
test("the lab's uploaded cover is one file, like the API's, still eager and high priority", () => {
  for (const style of ['stage', 'horizon']) {
    const html = over(style, {
      profile: {
        cover: { kind: 'photo', path: '/dev/studio-lab/cover/1.webp' },
      },
    });
    const tag = /<img class="studio-cover__photo"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(tag, / src="\/dev\/studio-lab\/cover\/1\.webp"/, style);
    assert.doesNotMatch(tag, /srcset/i, style);
    assert.match(tag, /fetchpriority="high"/i, style);
    assert.match(tag, /loading="eager"/, style);
  }
});

test('a selected amount differs from the others by more than colour, in Stage and Horizon', () => {
  const chip = (style) =>
    `.studio[data-style='${style}'] .studio-tip .tm-amount-choice`;
  // Stage: the label steps up in weight.
  const stage = sheet('stage');
  const off = Number(
    /font-weight: (\d+)/.exec(
      declarations(stage, `${chip('stage')} > span`),
    )[1],
  );
  const on = Number(
    /font-weight: (\d+)/.exec(
      declarations(stage, `${chip('stage')} input:checked + span`),
    )?.[1],
  );
  assert.ok(on >= off + 150, `Stage: ${off} → ${on}`);
  // Horizon (400 and 500 only): a dot marks the chosen chip.
  const dot = declarations(
    sheet('horizon'),
    `${chip('horizon')} input:checked + span::after`,
  );
  assert.match(dot, /content: '';/);
  assert.match(dot, /width: 6px;/);
  assert.doesNotMatch(dot, /display: none/);
});

test('Horizon\'s Tip area shows a focus ring when "Send a tip" lands on it', () => {
  const focus = declarations(
    sheet('horizon'),
    ".studio[data-style='horizon'] .studio-tip:focus",
  );
  assert.match(focus, /outline: 2px solid var\(--studio-accText\);/);
  assert.doesNotMatch(focus, /outline: none/);
});

// Signboard, Sprint and Tiles (PR 2e, spec §9.5, §9.6, §9.7, §9.10).
const NEW = ['signboard', 'sprint', 'tiles'];
const styled = (style, { cover, mode, profile = {}, blocks } = {}) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
      studio: {
        document: doc({
          style,
          ...(cover ? { cover } : {}),
          ...(mode ? { mode } : {}),
          ...(blocks ? { blocks } : {}),
        }),
        images: {
          [IMG]: {
            path: `/dev/studio-lab/image/${IMG}`,
            width: 2400,
            height: 1600,
          },
        },
        palette: studioTokens(style, null),
        checkVersion: DESIGN_CHECK_VERSION,
      },
      profile: {
        handle: 'studiolab',
        displayName: 'Kemi Adeyinka',
        role: 'Singer, Lagos',
        bio: 'I write songs about home.',
        links: LINKS,
        plan: 'pro',
        cover: LAB_COVER,
        ...profile,
      },
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
const fontFiles = (html) =>
  [...html.matchAll(/src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
const fontPreloads = (html) =>
  [
    ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g),
  ].map((m) => m[1]);

test('Signboard sets the name in Unbounded, Sprint in Anton, Tiles in Inter: at most 2 families, 4 files, 200 KB, the name face preloaded', () => {
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  const face = {
    signboard: STUDIO_FONTS.find((f) => f.id === 'unbounded'),
    sprint: STUDIO_FONTS.find((f) => f.id === 'anton'),
    tiles: null,
  };
  for (const style of NEW) {
    const html = styled(style);
    const files = fontFiles(html);
    const want = [...inter.files, ...(face[style]?.files ?? [])];
    assert.deepEqual(files.sort(), want.map((f) => f.path).sort(), style);
    assert.ok(files.length <= 4, style);
    assert.ok(
      want.reduce((s, f) => s + f.bytes, 0) <= 200 * 1024,
      `${style}: font bytes`,
    );
    assert.ok(
      want.every((f) => f.bytes <= 100 * 1024),
      `${style}: one file ≤ 100 KB`,
    );
    assert.deepEqual(
      fontPreloads(html),
      [(face[style] ?? inter).files[0].path],
      style,
    );
  }
  // Unbounded has no µ (§4.1): such a name is wholly Inter 700, and Inter is preloaded.
  const micro = styled('signboard', { profile: { displayName: 'Kemi µ Ade' } });
  assert.match(micro, /class="studio-name studio-name--fallback"/);
  assert.deepEqual(fontPreloads(micro), [inter.files[0].path]);
  // Sprint's titles and Tiles' are Inter; Sprint's Anton is the name only (§9.6).
  assert.doesNotMatch(
    declarations(sheet('sprint'), ".studio[data-style='sprint'] .studio-title"),
    /font-family/,
  );
  assert.match(
    declarations(sheet('sprint'), ".studio[data-style='sprint'] .studio-name"),
    /font-family: 'Studio Anton', 'Studio Anton Fallback'/,
  );
  assert.match(
    declarations(
      sheet('signboard'),
      ".studio[data-style='signboard'] :is(.studio-name, .studio-kicker, .studio-title)",
    ),
    /font-family: 'Studio Unbounded', 'Studio Unbounded Fallback'/,
  );
  assert.doesNotMatch(sheet('tiles'), /'Studio (?!Inter)/);
});

test("the design check measures Signboard's, Sprint's and Tiles' section titles at the size their CSS draws", () => {
  for (const style of NEW)
    assert.equal(
      STUDIO_HEADING_PX[style],
      px(
        declarations(
          sheet(style),
          `.studio[data-style='${style}'] .studio-title`,
        ),
        'font-size',
      ),
      style,
    );
  // Signboard's are capitals, tracked +0.03 em (the check measures them so).
  assert.match(
    declarations(
      sheet('signboard'),
      ".studio[data-style='signboard'] .studio-title",
    ),
    /letter-spacing: 0\.03em;[\s\S]*text-transform: uppercase;/,
  );
});

const stripSizes = (html) =>
  /<ul class="studio-strip"[\s\S]*?sizes="([^"]+)"/.exec(html)?.[1];
const photoSizes = (html) =>
  /<figure class="studio-photo"><img[^>]*sizes="([^"]+)"/.exec(html)?.[1];
const PHOTO_BLOCK = {
  id: 'phot0001',
  kind: 'photo',
  imageId: IMG,
  alt: 'A stage',
};

test("the design check's photo slots are the widths Signboard's CSS draws, and sizes follows them", () => {
  const css = sheet('signboard');
  const root = ".studio[data-style='signboard']";
  assert.equal(px(declarations(css, root), '--gutter'), 20);
  const tablet = declarations(css, root, 'min-width: 768px');
  assert.equal(px(tablet, '--gutter'), 24);
  assert.equal(px(tablet, '--measure'), 720);
  const strip = declarations(css, `${root} .studio-strip`);
  const n = Number(/grid-template-columns: repeat\((\d+),/.exec(strip)[1]);
  const gap = px(strip, 'gap');
  assert.equal(n, 3);
  assert.equal(gap, 8);
  for (const v of [320, 390])
    assert.equal(
      studioSlotWidth('signboard', 'gallery', v),
      Math.round((v - 40 - (n - 1) * gap) / n),
      `${v}`,
    );
  assert.equal(
    studioSlotWidth('signboard', 'gallery', 800),
    Math.round((720 - (n - 1) * gap) / n),
  );
  // Desktop: 440 | 80 | 600 in the 1120 content; the first section on the left, the rest right.
  const cols =
    /grid-template-columns:[^;]*minmax\(0, (\d+)px\) (\d+)px minmax\(0, (\d+)px\)/.exec(
      declarations(css, `${root} .studio-page`, 'min-width: 1024px'),
    );
  assert.ok(cols, "Signboard's desktop columns");
  assert.deepEqual(cols.slice(1).map(Number), [440, 80, 600]);
  const right = Number(cols[3]);
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('signboard', kind, 1440), right, kind);
  assert.equal(
    studioSlotWidth('signboard', 'gallery', 1440),
    Math.round((right - (n - 1) * gap) / n),
  );
  assert.equal(
    stripSizes(styled('signboard')),
    `(min-width: 1024px) ${studioSlotWidth('signboard', 'gallery', 1440)}px, (min-width: 768px) ${studioSlotWidth('signboard', 'gallery', 1023)}px, ${studioSlotWidth('signboard', 'gallery', 390)}px`,
  );
});

test("the design check's photo slots are the widths Sprint's CSS draws: photos edge to edge, the rest in the 680 cell", () => {
  const css = sheet('sprint');
  const root = ".studio[data-style='sprint']";
  assert.equal(px(declarations(css, root), '--gutter'), 20);
  // Photos run edge to edge: out of the gutters, 2-up with 2 px gaps; an odd first takes the row.
  const strip = declarations(css, `${root} .studio-strip`);
  assert.match(strip, /margin-inline: calc\(-1 \* var\(--gutter\)\);/);
  assert.match(strip, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.equal(px(strip, 'gap'), 2);
  assert.match(
    declarations(
      css,
      `${root} .studio-strip li:first-child:nth-last-child(odd)`,
    ),
    /grid-column: 1 \/ -1;/,
  );
  assert.match(
    declarations(css, `${root} .studio-photo`),
    /margin-inline: calc\(-1 \* var\(--gutter\)\);/,
  );
  for (const v of [320, 390, 800, 1440]) {
    assert.equal(studioSlotWidth('sprint', 'photo', v), v);
    assert.equal(studioSlotWidth('sprint', 'gallery', v), v);
  }
  // Desktop: a photo section is full-bleed; the rest sit in 1fr | 480, gap 120, padding 80.
  const grid = declarations(css, `${root} .studio-grid`, 'min-width: 1024px');
  assert.match(
    grid,
    /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 480px\);/,
  );
  const left =
    1440 - 2 * px(grid, 'padding-inline') - px(grid, 'column-gap') - 480;
  for (const kind of ['text', 'quote', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('sprint', kind, 1440), left, kind);
  assert.match(
    declarations(
      css,
      `${root} .studio-section[data-media]`,
      'min-width: 1024px',
    ),
    /grid-column: 1 \/ -1;/,
  );
  // Full-bleed photos ask for the screen.
  const html = styled('sprint', { blocks: [...doc().blocks, PHOTO_BLOCK] });
  // One photo in a gallery takes the whole row at every width.
  assert.equal(stripSizes(html), '(min-width: 1024px) 100vw, 100vw');
  assert.equal(photoSizes(html), '100vw');
});

test("the design check's photo slots are the widths Tiles' CSS draws, and sizes follows them", () => {
  const css = sheet('tiles');
  const root = ".studio[data-style='tiles']";
  assert.equal(px(declarations(css, root), '--gutter'), 20);
  const grid = declarations(css, `${root} .studio-grid`);
  assert.match(grid, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.equal(px(grid, 'gap'), 12);
  // A gallery photo is one tile; the last of a row closes it, so the widest is the column.
  for (const v of [320, 390])
    assert.equal(studioSlotWidth('tiles', 'gallery', v), v - 40);
  // Desktop: a 340 rail, 72, then a 788 grid of 4 columns, gap 16 (the content is 1200).
  const cols =
    /grid-template-columns:[^;]*min\((\d+)px, [\d.]+vw\) (\d+)px minmax\(0, (\d+)px\)/.exec(
      declarations(css, `${root} .studio-page`, 'min-width: 1024px'),
    );
  assert.ok(cols, "Tiles' desktop columns");
  assert.deepEqual(cols.slice(1).map(Number), [340, 72, 788]);
  const desk = declarations(css, `${root} .studio-grid`, 'min-width: 1024px');
  assert.match(desk, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  const g = px(desk, 'gap');
  assert.equal(g, 16);
  const tile = Math.round((788 - 3 * g) / 4);
  assert.equal(studioSlotWidth('tiles', 'gallery', 1440), 788);
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('tiles', kind, 1440), 788, kind);
  // Every block but a gallery's photos spans the grid's whole row.
  assert.match(
    declarations(css, `${root} .studio-block`),
    /grid-column: 1 \/ -1;/,
  );
  // Each photo asks for the width it is drawn at: a tile, or the span that closes its row.
  const sizesOf = (n) =>
    [
      ...styled('tiles', {
        blocks: [
          {
            id: 'gall0001',
            kind: 'gallery',
            images: Array.from({ length: n }, () => ({
              imageId: IMG,
              alt: 'A',
            })),
          },
        ],
      }).matchAll(/<li><img[^>]*sizes="([^"]+)"/g),
    ].map((m) => m[1]);
  const at = (desk, tablet, phone) =>
    `(min-width: 1024px) ${desk}px, (min-width: 768px) ${tablet}px, ${phone}px`;
  const span = (k) => k * tile + (k - 1) * g;
  // Three photos: the third spans two columns on a desktop and the whole row on a phone.
  assert.deepEqual(sizesOf(3), [
    at(tile, 354, 169),
    at(tile, 354, 169),
    at(span(2), 720, 350),
  ]);
  // Five: the fifth spans all four on a desktop (the slot), and the row on a phone.
  assert.equal(sizesOf(5)[4], at(788, 720, 350));
  assert.equal(sizesOf(4)[3], at(tile, 354, 169));
  assert.equal(sizesOf(2)[1], at(span(3), 354, 169));
});

test('the Tiles grid closes its rows: count rules for links and photos, and a tile beside the Tip', () => {
  const css = sheet('tiles');
  const desk = (sel) =>
    declarations(
      css,
      `.studio[data-style='tiles'] ${sel}`,
      'min-width: 1024px',
    );
  // Links beside the Tip (no cover): two there, then rows of four, the last closing its row.
  assert.match(
    desk('.studio-links__list li:last-child:nth-child(4n + 3)'),
    /grid-column: span 4;/,
  );
  assert.match(
    desk('.studio-links__list li:last-child:nth-child(4n)'),
    /grid-column: span 3;/,
  );
  // A gallery's last photo spans what its row has left.
  assert.match(
    desk('.studio-strip li:last-child:nth-child(4n + 1)'),
    /grid-column: span 4;/,
  );
  // The cover, or the first block when there is neither a cover nor links, sits beside the Tip.
  assert.match(desk('.studio-block[data-beside]'), /grid-column: 3 \/ 5;/);
  assert.match(
    declarations(
      css,
      ".studio[data-style='tiles'] .studio-strip li:last-child:nth-child(odd)",
    ),
    /grid-column: 1 \/ -1;/,
  );
  // The page marks that first block only when nothing else can sit there.
  const blocks = [
    { id: 'head0001', kind: 'text', variant: 'heading', text: 'News' },
    { id: 'text0001', kind: 'text', variant: 'paragraph', text: 'Hi.' },
  ];
  const beside = (o) =>
    (styled('tiles', { blocks, ...o }).match(/data-beside=""/g) ?? []).length;
  // No photo: the first section goes whole, its heading over its words (fix round 2).
  assert.equal(beside({ cover: 'plain', profile: { links: [] } }), 1);
  assert.match(
    styled('tiles', { blocks, cover: 'plain', profile: { links: [] } }),
    /<div class="studio-section"[^>]* data-beside=""><div class="studio-block" data-kind="text"><h2/,
  );
  // A photo alone under its heading takes the heading with it.
  const lone = styled('tiles', {
    blocks: [
      ...blocks,
      { id: 'head0002', kind: 'text', variant: 'heading', text: 'Photos' },
      PHOTO_BLOCK,
    ],
    cover: 'plain',
    profile: { links: [] },
  });
  assert.match(
    lone,
    /<div class="studio-section"[^>]* data-beside=""><div class="studio-block" data-kind="text"><h2[^>]*>Photos/,
  );
  assert.equal(beside({ cover: 'plain' }), 0);
  // With a photo on the page, the photo goes beside the Tip, not the first text (fix round 2).
  const withPhoto = styled('tiles', {
    blocks: [...blocks, PHOTO_BLOCK],
    cover: 'plain',
    profile: { links: [] },
  });
  assert.match(
    withPhoto,
    /<div class="studio-block" data-kind="photo" data-beside="">/,
  );
  assert.equal(withPhoto.match(/data-beside=""/g).length, 1);
  // Text beside the Tip keeps its own height (top-aligned), a photo fills the Tip's.
  assert.match(
    declarations(
      sheet('tiles'),
      ".studio[data-style='tiles'] .studio-section[data-beside]",
      'min-width: 1024px',
    ),
    /align-self: start;/,
  );
  // The links' title row sizes to its content (WCAG 1.4.4), never a fixed height.
  assert.doesNotMatch(sheet('tiles'), /grid-template-rows: \d+px/);
  assert.equal(beside({ cover: 'gradient', profile: { links: [] } }), 0);
});

test('Sprint gives every photo block a section of its own, so it runs edge to edge (ruling AC)', () => {
  const html = styled('sprint', {
    blocks: [
      { id: 'head0001', kind: 'text', variant: 'heading', text: 'News' },
      { id: 'text0001', kind: 'text', variant: 'paragraph', text: 'Hi.' },
      {
        id: 'gall0001',
        kind: 'gallery',
        images: [1, 2, 3].map(() => ({ imageId: IMG, alt: 'A' })),
      },
      { id: 'text0002', kind: 'text', variant: 'paragraph', text: 'After.' },
    ],
  });
  const sections = [
    ...html.matchAll(/<div class="studio-section"([^>]*)>/g),
  ].map((m) => m[1]);
  assert.deepEqual(sections, ['', ' data-media=""', '']);
  // Each photo asks for what it is drawn at: an odd first takes the row on a phone; on a
  // desktop three share it.
  const sizes = [...html.matchAll(/<li><img[^>]*sizes="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(sizes, [
    '(min-width: 1024px) 34vw, 100vw',
    '(min-width: 1024px) 34vw, 50vw',
    '(min-width: 1024px) 34vw, 50vw',
  ]);
  // Other styles keep a mixed section whole.
  const clear = styled('clear', {
    blocks: [
      { id: 'text0001', kind: 'text', variant: 'paragraph', text: 'Hi.' },
      PHOTO_BLOCK,
    ],
  });
  assert.equal(clear.match(/class="studio-section"/g).length, 1);
});

test("Signboard's photo cover is full-bleed, 16:9 up to 560 tall", () => {
  const css = sheet('signboard');
  const cover = declarations(
    css,
    ".studio[data-style='signboard'] .studio-cover[data-cover='photo']",
  );
  assert.match(cover, /width: 100%;/);
  assert.match(cover, /height: min\(56\.25vw, 560px\);/);
  assert.doesNotMatch(css, /max-height: 560px/);
});

test("Sprint's plain cover puts the Tip in the right half of a desktop hero", () => {
  const plain = declarations(
    sheet('sprint'),
    ".studio[data-style='sprint']:has(.studio-cover[data-cover='plain']) .studio-tip",
    'min-width: 1024px',
  );
  assert.match(plain, /grid-column: 2;/);
});

test("the sticky bar's observer also waits on the page's own name (ruling AA)", () => {
  const form = readFileSync(
    new URL('../src/components/appreciation-form.tsx', import.meta.url),
    'utf8',
  );
  assert.match(form, /host\.closest\('\.studio'\)/);
  assert.match(form, /querySelectorAll\('\[data-tip-cta\], \.studio-name'\)/);
  assert.doesNotMatch(form, /document\.querySelectorAll\('\[data-tip-cta\]'\)/);
});

test('Signboard sets the role and the name in the accent band, with the avatar and handle below', () => {
  const html = styled('signboard', { cover: 'plain' });
  assert.match(
    html,
    /<div class="studio-band"><p class="studio-kicker">Singer, Lagos<\/p><h1 id="studio-name" class="studio-name">Kemi Adeyinka<\/h1><\/div>/,
  );
  // The identity below holds the avatar, the handle (the role is in the band), the bio.
  const identity =
    /<header class="studio-identity"[^>]*>([\s\S]*?)<\/header>/.exec(html)[1];
  assert.match(identity, /class="studio-avatar"/);
  assert.match(identity, /@studiolab/);
  assert.doesNotMatch(identity, /Singer, Lagos|<h1/);
  assert.match(identity, /I write songs about home\./);
  assert.equal(html.match(/<h1/g).length, 1);
  // The band: acc fill, accLabel text, 72/20/76 (desktop 96/104), a 2 px ink rule.
  const css = sheet('signboard');
  const band = declarations(
    css,
    ".studio[data-style='signboard'] .studio-band",
  );
  assert.match(band, /background: var\(--studio-acc\);/);
  assert.match(band, /color: var\(--studio-accLabel\);/);
  assert.match(band, /padding: 72px var\(--gutter\) 76px;/);
  assert.match(band, /border-bottom: 2px solid var\(--studio-ink\);/);
  assert.match(
    declarations(
      css,
      ".studio[data-style='signboard'] .studio-band",
      'min-width: 1024px',
    ),
    /padding-block: 96px 104px;/,
  );
  // "Your cover" as a photo: full-bleed 16:9 above, the name in a short band below, never over it.
  const photo = styled('signboard');
  assert.ok(
    photo.indexOf('data-cover="photo"') < photo.indexOf('class="studio-band"'),
  );
  assert.match(
    declarations(
      css,
      ".studio[data-style='signboard'] .studio-cover[data-cover='photo']",
    ),
    /height: min\(56\.25vw, 560px\);/,
  );
});

test('Signboard and Sprint offer no gradient', () => {
  for (const style of ['signboard', 'sprint']) {
    // The resolver draws "Your cover" instead, and the sheet has no gradient treatment.
    assert.equal(doc({ style, cover: 'gradient' }).cover, 'yours', style);
    assert.doesNotMatch(sheet(style), /gradient/, style);
  }
  assert.equal(doc({ style: 'tiles', cover: 'gradient' }).cover, 'gradient');
});

test("Signboard's first section leads its desktop's left column, drawn once per width", () => {
  const html = styled('signboard');
  // The left column holds the identity, the Tip and the first section's copy; the main column
  // holds the links and every section, the first marked so a desktop hides it there.
  const side =
    /<div class="studio-side">([\s\S]*?)<div class="studio-grid">/.exec(html);
  assert.ok(side, 'the left column');
  assert.match(side[1], /<header class="studio-identity"/);
  assert.match(side[1], /id="the-tip"/);
  assert.match(
    side[1],
    /<div class="studio-blocks studio-blocks--lead"><div class="studio-section">[\s\S]*?News/,
  );
  const main = html.slice(html.indexOf('<div class="studio-grid">'));
  assert.match(main, /<div class="studio-section" data-lead="">[\s\S]*?News/);
  const css = sheet('signboard');
  assert.match(
    declarations(css, ".studio[data-style='signboard'] .studio-blocks--lead"),
    /display: none;/,
  );
  const desk = (sel) =>
    declarations(
      css,
      `.studio[data-style='signboard'] ${sel}`,
      'min-width: 1024px',
    );
  assert.match(desk('.studio-blocks--lead'), /display: grid;/);
  assert.match(desk('.studio-section[data-lead]'), /display: none;/);
  // Other styles draw their blocks once.
  assert.doesNotMatch(styled('tiles'), /studio-blocks--lead|data-lead/);
});

test('Sprint marks a section of photos only, so a desktop runs it edge to edge', () => {
  const html = styled('sprint', {
    blocks: [
      { id: 'head0001', kind: 'text', variant: 'heading', text: 'News' },
      { id: 'text0001', kind: 'text', variant: 'paragraph', text: 'Hi.' },
      { id: 'head0002', kind: 'text', variant: 'heading', text: 'Photos' },
      {
        id: 'gall0001',
        kind: 'gallery',
        images: [{ imageId: IMG, alt: 'A stage at night' }],
      },
      PHOTO_BLOCK,
    ],
  });
  const sections = [
    ...html.matchAll(/<div class="studio-section"([^>]*)>/g),
  ].map((m) => m[1]);
  assert.deepEqual(sections, ['', ' data-media=""']);
});

test('the Tip tile is first and two wide in Tiles, with "Send a tip" and "Goes to {first name}"', () => {
  const html = styled('tiles');
  // In the tile grid, before the links; the form's own heading stays for screen readers.
  const grid = html.slice(html.indexOf('<div class="studio-grid">'));
  assert.ok(grid.indexOf('class="studio-tip"') >= 0, 'the Tip is in the grid');
  assert.ok(
    grid.indexOf('class="studio-tip"') < grid.indexOf('class="studio-links"'),
  );
  assert.equal(html.match(/class="studio-tip"/g).length, 1);
  assert.match(
    grid,
    /<section class="studio-tip"[^>]*><div class="studio-tip__head"><h2 class="studio-tip__title">Send a tip<\/h2><p class="studio-tip__to">Goes to Kemi<\/p><\/div><form id="the-tip"/,
  );
  const css = sheet('tiles');
  const tip = declarations(css, ".studio[data-style='tiles'] .studio-tip");
  assert.match(tip, /grid-column: span 2;/);
  assert.match(tip, /background: var\(--studio-acc\);/);
  assert.match(tip, /color: var\(--studio-accLabel\);/);
  assert.match(tip, /border-radius: 24px;/);
  assert.match(tip, /padding: 20px;/);
  // The in-tile Tip is inverted; the phone bar's is the normal acc (§9.7).
  const inTile = declarations(
    css,
    ".studio[data-style='tiles'] .studio-tip .composer-action .composer-submit",
  );
  assert.match(inTile, /background: var\(--studio-accLabel\);/);
  assert.match(inTile, /color: var\(--studio-acc\);/);
  const bar = declarations(css, ".studio[data-style='tiles'] .tip-bar__button");
  assert.match(bar, /background: var\(--studio-acc\);/);
  assert.match(bar, /color: var\(--studio-accLabel\);/);
  // Unselected chips: a 1.5 px inset ring of accLabel at the registry's proved mix.
  assert.match(
    declarations(
      css,
      ".studio[data-style='tiles'] .studio-tip .tm-amount-choice > span",
    ),
    new RegExp(
      `box-shadow: inset 0 0 0 1\\.5px\\s+color-mix\\(in srgb, var\\(--studio-accLabel\\) ${Math.round(STUDIO_TILES_RING_MIX * 100)}%, var\\(--studio-acc\\)\\);`,
    ),
  );
  // Other styles keep the Tip out of the grid and have no tile head.
  assert.doesNotMatch(styled('sprint'), /studio-tip__head/);
});

test("Signboard's Tip has the one hard shadow 3px 3px 0, and no other shadow is drawn", () => {
  const css = sheet('signboard');
  const shadows = [...css.matchAll(/box-shadow: ([^;]+);/g)].map((m) => m[1]);
  assert.ok(shadows.includes('3px 3px 0 var(--studio-shadow)'));
  for (const s of shadows)
    assert.match(
      s,
      /^(none|3px 3px 0 var\(--studio-shadow\)|4px 4px 0 var\(--studio-shadow\))$/,
      s,
    );
  const tip = declarations(
    css,
    ".studio[data-style='signboard'] :is(.studio-tip .composer-submit, .tip-bar__button)",
  );
  assert.match(tip, /box-shadow: 3px 3px 0 var\(--studio-shadow\);/);
  assert.match(tip, /border: 2px solid var\(--studio-ink\);/);
  assert.match(tip, /font: 700 17px\/22px var\(--studio-ui\);/);
  // Tiles' only shadow is its light tile shadow (none in dark, from the registry).
  for (const s of [...sheet('tiles').matchAll(/box-shadow: ([^;]+);/g)].map(
    (m) => m[1],
  ))
    assert.match(
      s,
      /^(none|var\(--studio-shadow\)|inset 0 0 0 1\.5px[\s\S]*)$/,
      s,
    );
  // Sprint draws none.
  for (const s of [...sheet('sprint').matchAll(/box-shadow: ([^;]+);/g)].map(
    (m) => m[1],
  ))
    assert.equal(s, 'none');
});

test('long names step down in Signboard (over 18 letters, 30 to 24), Sprint (64 to 52 at 1.2, names with marks opened further) and Tiles (about 80%)', () => {
  const cls = (style, name) =>
    /<h1[^>]*class="([^"]+)"/.exec(
      styled(style, { profile: { displayName: name } }),
    )[1];
  // Signboard counts letters: 19 and up step down.
  assert.equal(cls('signboard', 'Kemi Adeyinka'), 'studio-name');
  assert.equal(
    cls('signboard', 'Abcdefghi Abcdefghij'),
    'studio-name studio-name--long',
  );
  assert.equal(cls('signboard', 'Abcdefghi Abcdefghi'), 'studio-name');
  assert.equal(
    cls('signboard', 'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí'),
    'studio-name studio-name--long',
  );
  assert.match(
    cls('sprint', 'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀'),
    /^studio-name studio-name--long/,
  );
  const name = (style, long = false) =>
    declarations(
      sheet(style),
      `.studio[data-style='${style}'] .studio-name${long ? '--long' : ''}`,
    );
  assert.equal(px(name('signboard'), 'font-size'), 30);
  assert.equal(px(name('signboard', true), 'font-size'), 24);
  assert.match(name('signboard'), /text-wrap: balance;/);
  assert.equal(px(name('sprint'), 'font-size'), 64);
  assert.equal(px(name('sprint'), 'line-height'), 76);
  assert.match(name('sprint'), /text-transform: uppercase;/);
  assert.match(name('sprint'), /letter-spacing: 0;/);
  assert.equal(px(name('sprint', true), 'font-size'), 52);
  assert.match(name('sprint', true), /line-height: 1\.2;/);
  // A name with marks opens further, whatever its size (ruling AB; e2e measures the ink).
  const marks = declarations(
    sheet('sprint'),
    ".studio[data-style='sprint'] .studio-name.studio-name--marks",
  );
  assert.ok(Number(/line-height: ([\d.]+);/.exec(marks)[1]) >= 1.35, marks);
  assert.match(cls('sprint', 'Ẹniọlá Bámidélé'), /studio-name--marks/);
  assert.doesNotMatch(cls('sprint', 'Kemi Adeyinka'), /studio-name--marks/);
  assert.doesNotMatch(cls('tiles', 'Ẹniọlá Bámidélé'), /studio-name--marks/);
  assert.equal(px(name('tiles'), 'font-size'), 28);
  const tiles = px(name('tiles', true), 'font-size');
  assert.ok(tiles / 28 >= 0.75 && tiles / 28 <= 0.85, `${tiles}`);
});

test('a selected amount differs from the others by more than colour, in Signboard, Sprint and Tiles', () => {
  for (const style of NEW) {
    const css = sheet(style);
    const chip = `.studio[data-style='${style}'] .studio-tip .tm-amount-choice`;
    const off = Number(
      /font-weight: (\d+)/.exec(declarations(css, `${chip} > span`))[1],
    );
    const on = Number(
      /font-weight: (\d+)/.exec(
        declarations(css, `${chip} input:checked + span`),
      )?.[1],
    );
    assert.ok(on >= off + 100, `${style}: ${off} → ${on}`);
  }
});

test('focus is 2 px, offset 3 in Signboard and Tiles (2 in Sprint); inside the Tip tile it is accLabel', () => {
  for (const [style, offset] of [
    ['signboard', 3],
    ['tiles', 3],
    ['sprint', 2],
  ]) {
    const css = sheet(style);
    if (offset === 2) {
      assert.doesNotMatch(css, /outline-offset: 3px/);
      continue;
    }
    const focus = declarations(
      css,
      `.studio[data-style='${style}'] :is(a, button, summary, input, select, textarea):focus-visible`,
    );
    assert.match(focus, /outline: 2px solid var\(--studio-accText\);/, style);
    assert.match(focus, new RegExp(`outline-offset: ${offset}px;`), style);
  }
  const inTile = declarations(
    sheet('tiles'),
    ".studio[data-style='tiles'] .studio-tip :is(a, button, summary, input, select, textarea):focus-visible",
  );
  assert.match(inTile, /outline-color: var\(--studio-tileFocus\);/);
  for (const style of NEW)
    assert.doesNotMatch(sheet(style), /outline: none/, style);
});

test('Signboard, Sprint and Tiles move as drawn, and under reduced motion only fade', () => {
  const sb = sheet('signboard');
  assert.match(sb, /120ms steps\(2\)/);
  assert.doesNotMatch(sb, /\b(?!120)\d+ms/);
  const sp = sheet('sprint');
  assert.match(sp, /--ease: cubic-bezier\(0\.4, 0, 0\.2, 1\);/);
  assert.doesNotMatch(sp, /\b(?!200)\d+ms/);
  const tl = sheet('tiles');
  assert.match(tl, /--ease: cubic-bezier\(0\.2, 0\.9, 0\.3, 1\.2\);/);
  assert.doesNotMatch(tl, /\b(?!250)\d+ms/);
  for (const style of NEW) {
    const css = sheet(style);
    // Only opacity, transform and colours move; never layout.
    for (const m of css.matchAll(/transition:([^;]+);/g))
      for (const part of m[1].split(','))
        assert.match(
          part.trim(),
          /^(none|(transform|opacity|filter|background-color|border-color|color|box-shadow) \d+ms[\s\S]*)$/,
          `${style}: ${part}`,
        );
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(reduced, `${style}: a reduced-motion block`);
    assert.match(reduced[1], /transform: none;/, style);
  }
});

// The site header over the cover (owner, 18 Nov 2026: "this header should be transparent or blend
// into the theme on the hero"). A page that starts with a full-bleed cover marks its root
// `data-header`; the frame then lays the header over the cover, transparent, its words white on a
// soft dark scrim (or, over Signboard's band, the band's own label colour), and gives it back the
// page's bg once the hero has scrolled past, with a scroll-driven animation inside @supports.
const headerOf = (html) =>
  /<div class="studio"[^>]*?data-header="([a-z]+)"/.exec(html)?.[1];

test('the header sits over the cover only where the page starts with a full-bleed cover', () => {
  const art = { cover: null };
  const want = [
    ['stage', 'yours', {}, 'over'],
    ['stage', 'yours', art, 'over'], // no photo: Stage's deep gradient, dark at the top
    ['stage', 'gradient', {}, 'over'],
    ['stage', 'plain', {}, undefined],
    ['horizon', 'yours', {}, 'over'],
    ['horizon', 'gradient', {}, undefined], // the name on card, no cover
    ['horizon', 'plain', {}, undefined],
    ['sprint', 'yours', {}, 'over'],
    ['sprint', 'yours', art, 'over'],
    ['sprint', 'plain', {}, undefined],
    ['signboard', 'yours', {}, 'over'],
    ['signboard', 'yours', art, 'over'],
    ['signboard', 'plain', {}, 'band'], // the band is the cover
    ['clear', 'yours', {}, 'over'],
    ['clear', 'yours', art, 'over'],
    ['clear', 'gradient', {}, undefined], // a pale tint beside bg: the bg header already blends
    ['clear', 'plain', {}, undefined],
    // Their pages start on bg: Journal's top rule, Linen's framed cover, Tiles' identity.
    ['journal', 'yours', {}, undefined],
    ['linen', 'yours', {}, undefined],
    ['tiles', 'yours', {}, undefined],
  ];
  for (const [style, cover, profile, mode] of want)
    assert.equal(
      headerOf(over(style, { cover, profile })),
      mode,
      `${style} ${cover}${profile.cover === null ? ' (cover art)' : ''}`,
    );
});

/** The Studio CSS inside the header's @supports block, and everything outside it. */
const SUPPORTS =
  '@supports (animation-timeline: view()) and (timeline-scope: none)';
function supportsBlock(css) {
  const at = css.indexOf(SUPPORTS);
  if (at < 0) return { inside: '', outside: css };
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0)
      return {
        inside: css.slice(at, i + 1),
        outside: css.slice(0, at) + css.slice(i + 1),
      };
  }
  throw new Error('unclosed @supports');
}
const frameCss = () =>
  unguarded(readFileSync(new URL('frame.css', src), 'utf8'));

test('every header-over-cover rule waits for scroll-driven animation support, in Studio CSS only', () => {
  const files = ['frame', ...STUDIO_STYLE_IDS.filter((s) => s !== 'classic')];
  for (const name of files) {
    const css = name === 'frame' ? frameCss() : sheet(name);
    const { outside } = supportsBlock(css);
    // Outside the block a browser without scroll timelines keeps today's solid header.
    assert.doesNotMatch(
      outside.replace(/\/\*[\s\S]*?\*\//g, ''),
      /data-header|studio-hero-timeline/,
      `${name}: header-over-cover rule outside @supports`,
    );
  }
  assert.match(
    supportsBlock(frameCss()).inside,
    /animation-timeline: --studio-hero;/,
  );
  const globals = readFileSync(
    new URL('../src/app/globals.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(globals, /data-header|studio-hero/);
  // Every selector in the block is scoped to a styled page.
  const inside = supportsBlock(frameCss()).inside.replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  for (const m of inside.matchAll(/(?:^|[;{}])\s*([^;{}@]+?)\s*\{/g)) {
    const sel = m[1].trim();
    // Keyframe stops (`0%, 85%`) are not selectors.
    if (/^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(sel)) continue;
    for (const one of sel.split(/,(?![^(]*\))/))
      assert.match(
        one.trim(),
        /^html:has\(\.studio\[data-style\]\[data-header/,
        `scoped: ${one.trim()}`,
      );
  }
});

/** A to-bottom gradient's stops as [alpha, px], from the header's top edge. */
function headerScrim(decls) {
  const g = /linear-gradient\(\s*to bottom,([\s\S]*?)\);/.exec(decls);
  assert.ok(g, `a to-bottom gradient in ${decls}`);
  return g[1]
    .split(/,(?![^(]*\))/)
    .map((p) => p.trim())
    .map((part) => {
      const at = /(\d+)px$/.exec(part);
      assert.ok(at, `a px stop: ${part}`);
      if (/^transparent/.test(part)) return [0, Number(at[1])];
      const rgba = /rgba\(\s*8,\s*8,\s*10,\s*([\d.]+)\)/.exec(part);
      assert.ok(rgba, part);
      return [Number(rgba[1]), Number(at[1])];
    });
}

// The header's words and keys end 60 px down (16 px + a 44 px key in the 76 px bar); where the
// site's links wrap to two lines (801 to about 1000 px) they reach 64. e2e measures it. The scrim
// is proved to 72 px.
const HEADER_TEXT_BOTTOM = 72;

test('the header over a cover is white on a scrim of at least 58% black wherever its words sit: 4.5:1', () => {
  const inside = supportsBlock(frameCss()).inside;
  const flat = inside.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const rule = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[{}]) ?${esc} \\{([^}]*)\\}`).exec(flat);
    assert.ok(m, sel);
    return m[1];
  };
  const over = "html:has(.studio[data-style][data-header='over'])";
  const scrim = rule(`${over} .site-header::before`);
  const stops = headerScrim(scrim);
  // It starts at the header's top edge, spans the screen, and fades to nothing below the header.
  assert.equal(stops[0][1], 0);
  assert.equal(stops.at(-1)[0], 0);
  assert.match(scrim, /inset: 0 0 auto;/);
  const height = /height: calc\(var\(--nav-height\) \+ (\d+)px\);/.exec(scrim);
  assert.ok(height, 'the scrim runs past the header');
  assert.ok(
    stops.at(-1)[1] <= 76 + Number(height[1]),
    'the fade ends inside the scrim',
  );
  assert.ok(
    stops[0][0] >= 0.45 && stops[0][0] <= 0.65,
    'about half black at the top',
  );
  const alphaAtPx = (y) => {
    for (let i = 1; i < stops.length; i += 1) {
      const [a0, p0] = stops[i - 1];
      const [a1, p1] = stops[i];
      if (y <= p1) return a0 + ((a1 - a0) * (y - p0)) / (p1 - p0 || 1);
    }
    return 0;
  };
  for (let y = 0; y <= HEADER_TEXT_BOTTOM; y += 1) {
    const a = alphaAtPx(y);
    assert.ok(a >= 0.58, `${a.toFixed(3)} black at ${y} px`);
    // White words over the scrim over a white photo, the worst cover there is.
    const under = blend('#08080a', a, '#ffffff');
    assert.ok(
      contrastRatio('#ffffff', under) >= 4.5,
      `${y} px: ${contrastRatio('#ffffff', under)}`,
    );
  }
  // The words are white; the wordmark is drawn in them (its purple would vanish on a photo).
  assert.match(rule(`${over} .site-header`), /--studio-head-over: #fff;/);
  assert.match(
    rule(
      'html:has(.studio[data-style][data-header]) .site-header .nav-shell > .brand .brand__mark',
    ),
    /--logo-ink: currentColor;\s*--logo-accent: currentColor;/,
  );
  // On a tip page the header is the logo alone (owner, 19 Nov 2026; globals.css): nothing here
  // styles the menu, its keys or "Who it's for", which never show over the cover.
  assert.doesNotMatch(
    flat,
    /nav-claim|tm-button|site-nav|menu-toggle|who__|--surface-raised|--edge-hairline|--border-material/,
  );
});

test("over Signboard's band the header takes the band's label colour, 4.5:1 on every accent", () => {
  const accents = [null, ...STUDIO_ACCENT_IDS.filter((a) => a !== 'photo')];
  const palettes = accents.map((a) => [
    String(a),
    studioTokens('signboard', a),
  ]);
  // "From your photo": accents picked round the hue circle, as the photo picker makes them.
  for (let h = 0; h < 360; h += 15) {
    const photo = pickPhotoAccent([oklchToHex({ l: 0.55, c: 0.14, h })]);
    if (!('failed' in photo))
      palettes.push([`photo ${h}`, studioTokens('signboard', 'photo', photo)]);
  }
  assert.ok(palettes.length > 12);
  for (const [name, p] of palettes)
    for (const mode of ['light', 'dark']) {
      const t = p[mode];
      const ratio = contrastRatio(t.accLabel, t.acc);
      assert.ok(ratio >= 4.5, `${name} ${mode}: ${ratio.toFixed(2)}`);
    }
  // The page writes the label colour where the header can read it (Signboard only).
  const blocks = chromeBlocks(over('signboard', { cover: 'plain' }));
  assert.equal(
    blocks[0].tokens.accLabel,
    studioTokens('signboard', null).light.accLabel,
  );
  for (const { tokens } of chromeBlocks(page()))
    assert.ok(!('accLabel' in tokens));
  const band = supportsBlock(frameCss()).inside;
  assert.match(
    band,
    /html:has\(\.studio\[data-style\]\[data-header='band'\]\) \.site-header \{\s*--studio-head-over: var\(--studio-accLabel\);\s*\}/,
  );
  // The header is the logo alone on a tip page: no purple key on the band, so no ring for one.
  assert.doesNotMatch(band, /--studio-head-ring|nav-claim/);
});

test('the header holds its ink over the shade, then switches ink, glass and shade together, with no fade between', () => {
  const inside = supportsBlock(frameCss()).inside;
  /** A keyframes block's stops as [[percent…], declarations]. */
  const stops = (name) => {
    const block = new RegExp(
      `@keyframes ${name} \\{([\\s\\S]*?)\\n {2}\\}`,
    ).exec(inside);
    assert.ok(block, name);
    return [...block[1].matchAll(/([\d%,\s]+)\{([^}]*)\}/g)].map((m) => [
      m[1].split(',').map((p) => Number.parseFloat(p)),
      m[2].replace(/\s+/g, ' ').trim(),
    ]);
  };
  const head = stops('studio-head');
  const scrim = stops('studio-head-scrim');
  const glass = stops('studio-head-glass');
  assert.equal(head.length, 2);
  assert.equal(scrim.length, 2);
  assert.equal(glass.length, 2);
  const [[holdAt, hold], [endAt, end]] = head;
  // Held from the top: the words in their over-the-cover ink on the full shade, no glass.
  assert.deepEqual(holdAt[0], 0);
  assert.match(hold, /--studio-head-ink: var\(--studio-head-over\);/);
  assert.deepEqual(scrim[0], [holdAt, 'opacity: 1;']);
  assert.deepEqual(glass[0], [holdAt, 'opacity: 0;']);
  // Then everything changes inside one short step (no mid-way where light words meet a light
  // half-drawn glass): the glass, the page's words, the purple "me", no shade. The header's own bg stays transparent: the glass is its own layer.
  assert.deepEqual(endAt.at(-1), 100);
  assert.ok(
    endAt[0] - holdAt.at(-1) <= 3,
    `a ${endAt[0] - holdAt.at(-1)}% step`,
  );
  assert.doesNotMatch(end, /background-color/);
  for (const want of [
    '--studio-head-ink: var(--studio-fg);',
    '--studio-head-me: #7a32f9;',
  ])
    assert.ok(end.includes(want), want);
  assert.deepEqual(scrim[1], [endAt, 'opacity: 0;']);
  assert.deepEqual(glass[1], [endAt, 'opacity: 1;']);
  // Colours and opacity only.
  for (const [, decls] of [...head, ...scrim, ...glass])
    for (const m of decls.matchAll(/([a-z-]+):/g))
      assert.match(
        m[1],
        /^(opacity|background-color|--studio-head-ink|--studio-head-me)$/,
        m[1],
      );
  const reduced =
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {2}\}/.exec(
      inside,
    );
  assert.ok(reduced, 'a reduced-motion block');
  assert.match(reduced[1], /animation-timing-function: steps\(1, end\);/);
  assert.match(
    frameCss(),
    /@property --studio-head-ink \{\s*syntax: '<color>';/,
  );
});

// The owner (18 Nov 2026): "keep it fixed but kind of make it glassy when you scroll". Past the hero
// the header is frosted glass: the page's bg, translucent, over a blur of what scrolls under it,
// with a hairline. Its own layer (::after), so the phone menu (fixed, inside the header) is never
// held inside a backdrop-filter's box.
test('past the hero the header is frosted glass, at the lowest bg opacity that keeps its words 4.5:1 over anything', () => {
  const inside = supportsBlock(frameCss()).inside;
  const flat = inside.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const glassRule =
    /html:has\(\.studio\[data-style\]\[data-header\]\) \.site-header::after \{([^}]*)\}/.exec(
      flat,
    );
  assert.ok(glassRule, 'the glass layer');
  const g = glassRule[1];
  const alpha =
    /background: color-mix\(in srgb, var\(--studio-bg\) (\d+)%, transparent\);/.exec(
      g,
    );
  assert.ok(alpha, 'a translucent bg');
  assert.match(g, /-webkit-backdrop-filter: blur\(\d+px\) saturate\([\d.]+\);/);
  assert.match(g, / backdrop-filter: blur\(\d+px\) saturate\([\d.]+\);/);
  assert.match(g, /border-bottom: 0\.5px solid var\(--studio-line\);/);
  assert.match(g, /z-index: -1;/);
  assert.match(g, /inset: 0;/);
  // The words on the glass, blur ignored, over the worst there is beneath: pure black and pure
  // white (a composite's luminance only grows with what is under it, so these bound every
  // colour). Every style, both modes; and one percent less fails somewhere, so it is the lowest.
  const passes = (pct) =>
    STUDIO_STYLE_IDS.filter((s) => s !== 'classic').every((style) =>
      ['light', 'dark'].every((mode) => {
        const t = studioTokens(style, null)[mode];
        return ['#000000', '#ffffff'].every(
          (under) => contrastRatio(t.fg, blend(t.bg, pct / 100, under)) >= 4.5,
        );
      }),
    );
  const pct = Number(alpha[1]);
  assert.ok(passes(pct), `${pct}% keeps 4.5:1`);
  assert.ok(
    !passes(pct - 1),
    `${pct - 1}% would also pass: ${pct}% is not the lowest`,
  );
  // Without backdrop-filter, or with reduced transparency asked for, the glass is today's solid bg.
  assert.match(
    flat,
    /@supports not \( ?\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) ?\) \{ html:has\(\.studio\[data-style\]\[data-header\]\) \.site-header::after \{ background: var\(--studio-bg\); \} \}/,
  );
  assert.match(
    flat,
    /@media \(prefers-reduced-transparency: reduce\) \{ html:has\(\.studio\[data-style\]\[data-header\]\) \.site-header::after \{ background: var\(--studio-bg\); -webkit-backdrop-filter: none; backdrop-filter: none; \} \}/,
  );
  // The header itself never takes a backdrop-filter (it would hold the fixed phone menu inside it).
  assert.doesNotMatch(flat, /\.site-header \{[^}]*backdrop-filter/);
});

test('a full-bleed cover photo is offered for the box it is drawn in, header strip included', () => {
  const img = (html) =>
    /<img class="studio-cover__photo"[^>]*sizes="([^"]+)"/.exec(html)?.[1];
  const w = (h) => Math.ceil((h * 16) / 9);
  const clear = sheet('clear');
  const phone = px(
    declarations(clear, ".studio[data-style='clear'] .studio-cover"),
    'height',
  );
  const desk = px(
    declarations(
      clear,
      ".studio[data-style='clear'] .studio-cover",
      'min-width: 1024px',
    ),
    'height',
  );
  assert.equal(
    img(over('clear')),
    `(min-width: 1024px) max(100vw, ${w(desk + NAV_HEIGHT)}px), max(100vw, ${w(phone + NAV_HEIGHT)}px)`,
  );
  const sprint = px(
    declarations(sheet('sprint'), ".studio[data-style='sprint'] .studio-cover"),
    'height',
  );
  assert.equal(
    img(over('sprint')),
    `(min-width: 1024px) 100vw, max(100vw, ${w(sprint + NAV_HEIGHT)}px)`,
  );
  const cap = /height: min\(56\.25vw, (\d+)px\);/.exec(
    declarations(
      sheet('signboard'),
      ".studio[data-style='signboard'] .studio-cover[data-cover='photo']",
    ),
  );
  assert.ok(cap);
  assert.equal(
    img(over('signboard')),
    `max(100vw, calc(min(100vw, ${w(Number(cap[1]))}px) + ${w(NAV_HEIGHT)}px))`,
  );
});

// Creator (addendum 2026-11-27-studio-creator-professional §6, §7.1, §7.4; Creator plan Task 3).
const { StyleIconRow } = await import(new URL('parts.mjs', out));
const { studioHeader } = await import(new URL('style-page.mjs', out));
/** Eight links, Instagram (an icon site) featured: the mixed case (Review Focus 1). */
const MIXED = [
  { platform: 'tiktok', url: 'https://www.tiktok.com/@kemisings' },
  {
    platform: 'instagram',
    url: 'https://www.instagram.com/kemisings',
    featured: true,
  },
  { platform: 'youtube', url: 'https://www.youtube.com/@kemisings' },
  { platform: 'x', url: 'https://x.com/kemisings' },
  { platform: 'twitch', url: 'https://www.twitch.tv/kemisings' },
  { platform: 'website', url: 'https://kemisings.com' },
  { platform: 'linkedin', url: 'https://www.linkedin.com/in/kemisings' },
  { platform: 'spotify', url: 'https://open.spotify.com/artist/kemi' },
];
const creator = ({ cover = 'yours', profile = {}, blocks } = {}) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
      studio: {
        document: doc({
          style: 'creator',
          mode: 'dark',
          cover,
          ...(blocks ? { blocks } : {}),
        }),
        images: {
          [IMG]: {
            path: `/dev/studio-lab/image/${IMG}`,
            width: 2400,
            height: 1600,
          },
        },
        palette: studioTokens('creator', null),
        checkVersion: DESIGN_CHECK_VERSION,
      },
      profile: {
        handle: 'studiolab',
        displayName: 'Kemi Adeyinka',
        role: 'Singer, Lagos',
        bio: 'I write songs about home.',
        links: MIXED,
        plan: 'pro',
        cover: LAB_COVER,
        ...profile,
      },
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
/** The markup inside the first element whose opening tag matches `open` (balanced on its tag). */
function inside(html, open) {
  const start = html.search(open);
  assert.ok(start >= 0, `${open} is on the page`);
  const tag = /^<([a-z]+)/.exec(html.slice(start))[1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`unclosed ${open}`);
}
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

test("Creator's DOM order is identity, icon row, chips and Tip, rows, blocks, Powered by, footer", () => {
  const html = creator();
  const at = (marker) => {
    const i = html.indexOf(marker);
    assert.ok(i >= 0, `${marker} is on the page`);
    return i;
  };
  const order = [
    at('class="studio-cover'),
    at('class="studio-identity'),
    at('class="studio-icons"'),
    at('id="the-tip"'),
    at('class="studio-rows"'),
    at('class="studio-blocks'),
    at('class="studio-powered"'),
    at('id="the-foot"'),
  ];
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  // §8's "Find me elsewhere" section is not drawn: the rows are its links.
  assert.doesNotMatch(html, /class="studio-links"/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /data-sheet="creator"/);
});

test('Creator splits links: follow sites in the icon row, the rest as rows, the featured link first, each once', () => {
  const html = creator();
  const icons = hrefs(inside(html, /<ul class="studio-icons"/));
  const rows = hrefs(inside(html, /<nav class="studio-rows"/));
  assert.deepEqual(icons, [
    'https://www.tiktok.com/@kemisings',
    'https://x.com/kemisings',
    'https://www.linkedin.com/in/kemisings',
  ]);
  // Instagram is featured: the first row, not an icon (Review Focus 1).
  assert.deepEqual(rows, [
    'https://www.instagram.com/kemisings',
    'https://www.youtube.com/@kemisings',
    'https://www.twitch.tv/kemisings',
    'https://kemisings.com',
    'https://open.spotify.com/artist/kemi',
  ]);
  for (const link of MIXED)
    assert.equal(html.split(`href="${link.url}"`).length - 1, 1, link.url);
  // Rows read the site's own row words (ruling S-R3's short forms for four sites).
  const nav = inside(html, /<nav class="studio-rows"/);
  for (const words of [
    'Follow on Instagram',
    'Watch me on YouTube',
    'Watch live on Twitch',
    'Visit my website',
    'Listen on Spotify',
  ])
    assert.match(nav, new RegExp(`>${words}<`), words);
  // Every link opens in a new tab, safely.
  assert.equal(
    html.match(/rel="noopener noreferrer nofollow ugc"/g)?.length,
    MIXED.length,
  );
  // No icons, or no rows: the empty list is not drawn.
  const onlyRows = creator({
    profile: { links: [MIXED[2], MIXED[4]] },
  });
  assert.doesNotMatch(onlyRows, /class="studio-icons"/);
  const onlyIcons = creator({ profile: { links: [MIXED[0], MIXED[3]] } });
  assert.doesNotMatch(onlyIcons, /class="studio-rows"/);
  const none = creator({ profile: { links: [] } });
  assert.doesNotMatch(none, /class="studio-(icons|rows)"/);
});

test('icon links are named "{Site}: {handle}, opens in a new tab"', () => {
  const html = renderToStaticMarkup(
    createElement(StyleIconRow, {
      links: [
        { platform: 'instagram', url: 'https://www.instagram.com/kemisings' },
        // Spotify shows no handle (a website's handle is its address).
        { platform: 'spotify', url: 'https://open.spotify.com/artist/kemi' },
      ],
    }),
  );
  // Named by its words (the badge's letters stay out of the tree), never an aria-label that could
  // differ from what shows.
  assert.doesNotMatch(html, /aria-label/);
  const names = [
    ...html.matchAll(
      /<a class="studio-icon"[^>]*>.*?<span class="sr-only">([^<]+)<\/span><\/a>/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(names, [
    'Instagram: @kemisings, opens in a new tab',
    'Spotify, opens in a new tab',
  ]);
  assert.match(html, /^<ul class="studio-icons">/);
  assert.equal(
    renderToStaticMarkup(createElement(StyleIconRow, { links: [] })),
    '',
  );
});

test('Creator\'s rows are a nav named "Find me elsewhere" with no visible title', () => {
  const html = creator();
  const nav = inside(html, /<nav class="studio-rows"/);
  assert.match(
    nav,
    /^<nav class="studio-rows" aria-label="Find me elsewhere">/,
  );
  assert.doesNotMatch(nav, /<h[1-6]/);
  // The words appear once, in the name, never as text.
  assert.equal(html.match(/Find me elsewhere/g)?.length, 1);
  // Each row: the badge, the words, the handle as sub when there is one, a chevron, "(opens in a
  // new tab)" for screen readers (ruling P6).
  assert.match(nav, /class="studio-link__sub"[^>]*>@kemisings</);
  assert.equal(nav.match(/class="studio-link__chevron"/g)?.length, 5);
  assert.equal(nav.match(/\(opens in a new tab\)/g)?.length, 5);
});

test('Powered by is one link home named "Powered by TipMe" with no query string', () => {
  const html = creator();
  const links = [...html.matchAll(/<a [^>]*class="studio-powered"[^>]*>/g)];
  assert.equal(links.length, 1);
  assert.match(links[0][0], / href="\/"/);
  assert.match(links[0][0], / aria-label="Powered by TipMe"/);
  assert.doesNotMatch(links[0][0], /\?/);
  // Next's link, never prefetching the home page as it scrolls into view.
  assert.match(links[0][0], / data-prefetch="false"/);
  const powered = inside(html, /<a [^>]*class="studio-powered"/);
  assert.match(powered, />Powered by </);
  assert.match(powered, /class="wordmark/);
  // The other styles show no "Powered by" (addendum §11.3).
  for (const style of ['clear', 'stage', 'horizon'])
    assert.doesNotMatch(over(style), /Powered by|studio-powered/, style);
});

test("Creator's cover box is Stage's", () => {
  assert.deepEqual(STYLE_COVER.creator, { tall: 564, desktopTall: 716 });
  const css = sheet('creator');
  assert.equal(
    px(declarations(css, ".studio[data-style='creator']"), '--tall') +
      NAV_HEIGHT,
    STYLE_COVER.creator.tall,
  );
  assert.equal(
    px(
      declarations(css, ".studio[data-style='creator']", 'min-width: 1024px'),
      '--tall',
    ) + NAV_HEIGHT,
    STYLE_COVER.creator.desktopTall,
  );
  // The photo is offered for that box: eager, high priority, sized for the tall crop.
  const tag =
    /<img class="studio-cover__photo"[^>]*>/.exec(creator())?.[0] ?? '';
  const phone = Math.ceil((564 * 16) / 9);
  const desk = Math.ceil((716 * 16) / 9);
  assert.match(tag, /fetchpriority="high"/i);
  assert.match(tag, /loading="eager"/);
  assert.match(
    tag,
    new RegExp(
      `sizes="\\(min-width: ${desk}px\\) 100vw, \\(min-width: 1024px\\) ${desk}px, \\(min-width: ${phone}px\\) 100vw, ${phone}px"`,
    ),
  );
});

test('Creator lays the header over a photo cover only', () => {
  assert.equal(studioHeader('creator', 'photo'), 'over');
  for (const kind of ['art', 'gradient', 'plain'])
    assert.equal(studioHeader('creator', kind), undefined, kind);
  assert.equal(headerOf(creator()), 'over');
  assert.equal(headerOf(creator({ cover: 'gradient' })), undefined);
});

test('Creator never sets text on the photo', () => {
  const html = creator();
  const cover = inside(html, /<div class="studio-cover"/);
  assert.match(cover, /data-cover="photo"/);
  assert.match(cover, /studio-cover__fade/);
  assert.doesNotMatch(
    cover,
    /studio-(name|meta|bio|kicker|scrim|celebration)|<h1|<p/,
  );
  // The identity follows the cover; it is not inside it.
  assert.ok(html.indexOf('class="studio-identity') > html.indexOf(cover));
});

test('Creator draws no verified mark', () => {
  for (const plan of ['pro', 'free']) {
    const html = creator({ profile: { plan } });
    // The name is the h1's only content, and the meta line follows it.
    assert.match(
      html,
      /<h1 id="studio-name" class="studio-name">Kemi Adeyinka<\/h1><p class="studio-meta">/,
    );
    assert.doesNotMatch(html, /verified/i);
  }
});

test("a non-photo Your cover draws Creator's gradient treatment (design, automatic, animated)", () => {
  const covers = {
    design: { kind: 'design', design: 'danfo' },
    automatic: resolveCover({
      handle: 'coverauto',
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    }),
    animated: { kind: 'animated', animation: 'drift', play: 'loop' },
  };
  for (const [name, cover] of Object.entries(covers)) {
    const html = creator({ profile: { cover } });
    assert.match(
      inside(html, /<div class="studio-cover"/),
      /^<div class="studio-cover" data-cover="gradient" aria-hidden="true">/,
      name,
    );
    // Today's cover art is not drawn in a box made for a photo.
    assert.doesNotMatch(html, /id="the-art"|studio-cover__photo/, name);
    // A pale gradient in light mode: no header laid over it.
    assert.equal(headerOf(html), undefined, name);
  }
  // Gradient and plain are the style's own.
  assert.match(creator({ cover: 'gradient' }), /data-cover="gradient"/);
  assert.match(creator({ cover: 'plain' }), /data-cover="plain"/);
});

test("Creator's Tip and the sticky bar's pill draw their 1 px edges in deepEdge and deepBarEdge", () => {
  const css = sheet('creator');
  const tip = declarations(
    css,
    ".studio[data-style='creator'] .studio-tip .composer-submit",
  );
  assert.match(tip, /border: 1px solid var\(--studio-deepEdge\);/);
  assert.match(
    tip,
    /background: linear-gradient\(\s*180deg,\s*var\(--studio-deep\),\s*var\(--studio-deepEnd\)\s*\);/,
  );
  assert.match(tip, /color: var\(--studio-deepLabel\);/);
  assert.doesNotMatch(tip, /box-shadow: (?!none)/);
  const bar = declarations(
    css,
    ".studio[data-style='creator'] .tip-bar__button",
  );
  assert.match(bar, /border: 1px solid var\(--studio-deepBarEdge\);/);
  assert.match(bar, /background: var\(--studio-deep\);/);
  // The tokens are on the page's root, from the registry (the page is in dark mode).
  const t = studioTokens('creator', null).dark;
  const root = rootTag(creator());
  assert.match(root, new RegExp(`--studio-deepEdge:${t.deepEdge}`));
  assert.match(root, new RegExp(`--studio-deepBarEdge:${t.deepBarEdge}`));
  // No glow behind Creator's Tip (§6.1).
  assert.doesNotMatch(
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
    /glow|(?<!backdrop-)filter: blur|box-shadow: (?!none|inset)/,
  );
  // Creator's phone section title is the size the design check measures (ruling P3).
  assert.equal(
    px(
      declarations(css, ".studio[data-style='creator'] .studio-title"),
      'font-size',
    ),
    STUDIO_HEADING_PX.creator,
  );
});

// The nine older styles render exactly as before Creator (addendum §9.6): their lab examples, with
// a mixed set of links and a featured one, pinned before Creator's renderer landed.
const LAB = await (async () => {
  build('examples.mjs', '../../app/dev/studio-lab/examples.ts');
  return import(new URL('examples.mjs', out));
})();
const NINE = [
  'classic',
  'clear',
  'journal',
  'stage',
  'signboard',
  'sprint',
  'tiles',
  'linen',
  'horizon',
];
const labMarkup = (style) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
      studio: {
        document: LAB.LAB_STYLE_EXAMPLES[style],
        images: Object.fromEntries(
          LAB.LAB_IMAGES.map((id) => [
            id,
            { path: `/dev/studio-lab/image/${id}`, width: 2400, height: 1600 },
          ]),
        ),
        palette: studioTokens(style, null),
        checkVersion: DESIGN_CHECK_VERSION,
      },
      profile: {
        handle: 'studiolab',
        displayName: 'Kemi Adeyinka',
        role: 'Singer, Lagos',
        bio: 'I write songs about home.',
        links: MIXED,
        plan: 'pro',
        cover: LAB_COVER,
        celebration: { momentId: 'm', label: '10th tip' },
      },
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
const PINNED_MARKUP = JSON.parse(
  readFileSync(
    new URL('./fixtures/studio-markup-before-creator.json', import.meta.url),
    'utf8',
  ),
);

test("no other style's markup changes", () => {
  assert.deepEqual(Object.keys(PINNED_MARKUP), NINE);
  for (const style of NINE)
    assert.equal(labMarkup(style), PINNED_MARKUP[style], style);
});

// Creator renders exactly as before Professional: its lab example and its cover and link cases,
// pinned on f55c0c63 before Professional's renderer landed.
const PINNED_CREATOR = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/studio-markup-before-professional.json',
      import.meta.url,
    ),
    'utf8',
  ),
).creator;

test("Creator's markup is unchanged by Professional", () => {
  const now = {
    lab: labMarkup('creator'),
    mixed: creator(),
    nophoto: creator({ profile: { avatarPath: undefined, bio: undefined } }),
    gradient: creator({ cover: 'gradient' }),
    plain: creator({ cover: 'plain' }),
    light: renderToStaticMarkup(
      createElement(StudioStylePage, {
        studio: {
          document: { ...LAB.LAB_STYLE_EXAMPLES.creator, mode: 'light' },
          images: {},
          palette: studioTokens('creator', 'amber'),
          checkVersion: DESIGN_CHECK_VERSION,
        },
        profile: {
          handle: 'studiolab',
          displayName: 'Kemi Adeyinka',
          links: MIXED,
          plan: 'pro',
          cover: LAB_COVER,
        },
        tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
        footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
        coverArt: createElement('div', { id: 'the-art' }),
      }),
    ),
  };
  assert.deepEqual(Object.keys(PINNED_CREATOR), Object.keys(now));
  for (const [name, html] of Object.entries(now))
    assert.equal(html, PINNED_CREATOR[name], name);
});

// Professional (addendum 2026-11-27-studio-creator-professional §6.5, §6.6, §7.2; Creator plan
// Task 4): a card rising over the cover holds the identity, the icon row, the link rows, the chips
// and the "Send a tip" pill, and "Powered by tipme" at its foot; the blocks follow the card.
const professional = ({
  cover = 'yours',
  mode = 'light',
  accent = null,
  profile = {},
  blocks,
} = {}) =>
  renderToStaticMarkup(
    createElement(StudioStylePage, {
      studio: {
        document: doc({
          style: 'professional',
          mode,
          accent,
          cover,
          ...(blocks ? { blocks } : {}),
        }),
        images: {
          [IMG]: {
            path: `/dev/studio-lab/image/${IMG}`,
            width: 2400,
            height: 1600,
          },
        },
        palette: studioTokens('professional', accent),
        checkVersion: DESIGN_CHECK_VERSION,
      },
      profile: {
        handle: 'studiolab',
        displayName: 'Ada Nwosu',
        role: 'Product manager',
        bio: 'Building solutions for a better tomorrow.',
        links: MIXED,
        plan: 'pro',
        cover: LAB_COVER,
        ...profile,
      },
      tipBlock: createElement('form', { id: 'the-tip' }, 'TIP'),
      footer: createElement('footer', { id: 'the-foot' }, 'FOOT'),
      coverArt: createElement('div', { id: 'the-art' }),
    }),
  );
/** The rising card: the first `studio-card` (a text block's card also carries `studio-text`). */
const cardOf = (html) => inside(html, /<div class="studio-card"(?=[ >])/);

test("Professional's card holds identity, icon row, rows, chips, Tip and Powered by, in that order, and the blocks follow the card", () => {
  const html = professional();
  const card = cardOf(html);
  const at = (where, marker) => {
    const i = where.indexOf(marker);
    assert.ok(i >= 0, `${marker} is in place`);
    return i;
  };
  const inCard = [
    at(card, 'class="studio-identity'),
    at(card, 'class="studio-icons"'),
    at(card, 'class="studio-rows"'),
    at(card, 'id="the-tip"'),
    at(card, 'class="studio-powered"'),
  ];
  assert.deepEqual(
    [...inCard].sort((a, b) => a - b),
    inCard,
  );
  // The card follows the cover; the blocks, then the footer, follow the card, never inside it.
  const cardAt = html.indexOf(card);
  assert.ok(at(html, 'class="studio-cover') < cardAt);
  assert.doesNotMatch(card, /class="studio-blocks|id="the-foot"/);
  const after = html.slice(cardAt + card.length);
  assert.ok(at(after, 'class="studio-blocks') < at(after, 'id="the-foot"'));
  // "Powered by tipme" at the card's foot: the last thing in it.
  assert.match(card, /<\/a><\/div><\/div>$/);
  assert.ok(
    card.lastIndexOf('class="studio-powered"') >
      card.lastIndexOf('id="the-tip"'),
  );
  // Links split as Creator's: follow sites as icons, the rest as rows, the featured link first.
  assert.deepEqual(hrefs(inside(card, /<ul class="studio-icons"/)), [
    'https://www.tiktok.com/@kemisings',
    'https://x.com/kemisings',
    'https://www.linkedin.com/in/kemisings',
  ]);
  assert.deepEqual(hrefs(inside(card, /<nav class="studio-rows"/)), [
    'https://www.instagram.com/kemisings',
    'https://www.youtube.com/@kemisings',
    'https://www.twitch.tv/kemisings',
    'https://kemisings.com',
    'https://open.spotify.com/artist/kemi',
  ]);
  for (const link of MIXED)
    assert.equal(html.split(`href="${link.url}"`).length - 1, 1, link.url);
  assert.match(
    inside(card, /<nav class="studio-rows"/),
    /^<nav class="studio-rows" aria-label="Find me elsewhere">/,
  );
  assert.doesNotMatch(html, /class="studio-links"/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /data-sheet="professional"/);
  // One "Powered by", named "Powered by TipMe", home, no query string.
  const powered = [...html.matchAll(/<a [^>]*class="studio-powered"[^>]*>/g)];
  assert.equal(powered.length, 1);
  assert.match(powered[0][0], / href="\/"/);
  assert.match(powered[0][0], / aria-label="Powered by TipMe"/);
});

test("Professional's card has no shadow", () => {
  const css = sheet('professional').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const card = rules.filter(
    ([, sel]) =>
      sel.includes(".studio[data-style='professional']") &&
      /\.studio-card\b/.test(sel),
  );
  assert.ok(card.length > 0, 'the card has rules');
  for (const [, sel, body] of card)
    for (const m of body.matchAll(/box-shadow:\s*([^;]+);/g))
      assert.equal(m[1].trim(), 'none', sel.trim());
  // §8 allows three shadows and Professional draws none: no drop shadow anywhere in its sheet
  // (an inset ring is a border, not a shadow), and no glass.
  assert.doesNotMatch(css, /box-shadow: (?!none;|inset )/);
  assert.doesNotMatch(css, /backdrop-filter: (?!none;)/);
});

test("Professional's cover box: 564 on a phone, 516 from 1024 px", () => {
  assert.deepEqual(STYLE_COVER.professional, { tall: 564, desktopTall: 516 });
  const css = sheet('professional');
  assert.equal(
    px(declarations(css, ".studio[data-style='professional']"), '--tall') +
      NAV_HEIGHT,
    STYLE_COVER.professional.tall,
  );
  assert.equal(
    px(
      declarations(
        css,
        ".studio[data-style='professional']",
        'min-width: 1024px',
      ),
      '--tall',
    ) + NAV_HEIGHT,
    STYLE_COVER.professional.desktopTall,
  );
  // The card rises 112 over a photo on a phone, 160 on a desktop (§7.2).
  assert.equal(
    px(declarations(css, ".studio[data-style='professional']"), '--rise'),
    112,
  );
  assert.equal(
    px(
      declarations(
        css,
        ".studio[data-style='professional']",
        'min-width: 1024px',
      ),
      '--rise',
    ),
    160,
  );
  // The photo is offered for that box.
  const tag =
    /<img class="studio-cover__photo"[^>]*>/.exec(professional())?.[0] ?? '';
  const phone = Math.ceil((564 * 16) / 9);
  const desk = Math.ceil((516 * 16) / 9);
  assert.match(tag, /fetchpriority="high"/i);
  assert.match(
    tag,
    new RegExp(
      `sizes="\\(min-width: ${desk}px\\) 100vw, \\(min-width: 1024px\\) ${desk}px, \\(min-width: ${phone}px\\) 100vw, ${phone}px"`,
    ),
  );
  // No words on the photo: the cover holds the photo alone.
  assert.doesNotMatch(
    inside(professional(), /<div class="studio-cover"/),
    /studio-(name|meta|bio|scrim)|<h1|<p/,
  );
});

test('Professional lays the header over a photo cover only', () => {
  assert.equal(studioHeader('professional', 'photo'), 'over');
  for (const kind of ['art', 'gradient', 'plain'])
    assert.equal(studioHeader('professional', kind), undefined, kind);
  assert.equal(headerOf(professional()), 'over');
  assert.equal(headerOf(professional({ cover: 'gradient' })), undefined);
  assert.equal(headerOf(professional({ cover: 'plain' })), undefined);
});

test('a non-photo Your cover renders as cover art in a 240 px band', () => {
  const covers = {
    design: { kind: 'design', design: 'danfo' },
    automatic: resolveCover({
      handle: 'coverauto',
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    }),
    animated: { kind: 'animated', animation: 'drift', play: 'loop' },
  };
  for (const [name, cover] of Object.entries(covers)) {
    const html = professional({ profile: { cover } });
    assert.match(
      inside(html, /<div class="studio-cover"/),
      /^<div class="studio-cover" data-cover="art"><div id="the-art"><\/div><\/div>$/,
      name,
    );
    assert.equal(headerOf(html), undefined, name);
    // needsPhoto is false: the design check shows no cover-photo notice.
    const notices = checkDesign(doc({ style: 'professional' }), {
      images: {},
      videos: {},
      profile: { name: 'Ada Nwosu', bio: true, links: 2 },
      plan: 'pro',
      coverKind: name,
      hasAvatar: true,
    }).notices.map((n) => n.rule);
    assert.ok(!notices.includes('cover-photo'), `${name}: ${notices}`);
  }
  // Creator, by contrast, asks for a photo.
  assert.ok(
    checkDesign(doc({ style: 'creator' }), {
      images: {},
      videos: {},
      profile: { name: 'Ada Nwosu', bio: true, links: 2 },
      plan: 'pro',
      coverKind: 'design',
      hasAvatar: true,
    })
      .notices.map((n) => n.rule)
      .includes('cover-photo'),
  );
  const css = sheet('professional');
  for (const kind of ['art', 'gradient'])
    assert.equal(
      px(
        declarations(
          css,
          `.studio[data-style='professional'] .studio-cover[data-cover='${kind}']`,
        ),
        'height',
      ),
      240,
      kind,
    );
});

test("Professional's gradient is two low-chroma tints of the accent: L .95 to .90 light, .28 to .22 dark", () => {
  const css = sheet('professional');
  assert.match(
    declarations(
      css,
      ".studio[data-style='professional'] .studio-cover[data-cover='gradient']",
    ),
    /background: linear-gradient\(\s*180deg,\s*var\(--studio-coverFrom\),\s*var\(--studio-coverTo\)\s*\);/,
  );
  for (const [mode, from, to] of [
    ['light', 0.95, 0.9],
    ['dark', 0.28, 0.22],
  ]) {
    const root = rootTag(
      professional({ cover: 'gradient', mode, accent: 'green' }),
    );
    const value = (k) =>
      new RegExp(`--studio-${k}:(#[0-9a-f]{6})`).exec(root)?.[1];
    assert.ok(value('coverFrom') && value('coverTo'), mode);
    assert.ok(Math.abs(hexToOklch(value('coverFrom')).l - from) < 0.01, mode);
    assert.ok(Math.abs(hexToOklch(value('coverTo')).l - to) < 0.01, mode);
    assert.ok(hexToOklch(value('coverFrom')).c <= 0.036, mode);
  }
});

test('Professional draws no verified mark', () => {
  for (const plan of ['pro', 'free']) {
    const html = professional({ profile: { plan } });
    assert.match(
      html,
      /<h1 id="studio-name" class="studio-name">Ada Nwosu<\/h1><p class="studio-meta">/,
    );
    assert.doesNotMatch(html, /verified/i);
  }
});

test('with no blocks the page ends at the card, then the footer', () => {
  const html = professional({ blocks: [] });
  const card = cardOf(html);
  const after = html.slice(html.indexOf(card) + card.length);
  assert.doesNotMatch(html, /class="studio-(blocks|grid)/);
  assert.match(
    after,
    /^<div class="studio-foot"><footer id="the-foot">FOOT<\/footer><\/div><\/div><\/div>$/,
  );
});

test("Professional's pill and the sticky bar's pill draw their 1 px edges in tipEdge and tipBarEdge", () => {
  const css = sheet('professional');
  const tip = declarations(
    css,
    ".studio[data-style='professional'] .studio-tip .composer-submit",
  );
  assert.match(tip, /border: 1px solid var\(--studio-tipEdge\);/);
  assert.match(tip, /background: var\(--studio-acc\);/);
  assert.match(tip, /color: var\(--studio-accLabel\);/);
  assert.match(tip, /border-radius: 999px;/);
  assert.equal(px(tip, 'min-height'), 56);
  const bar = declarations(
    css,
    ".studio[data-style='professional'] .tip-bar__button",
  );
  assert.match(bar, /border: 1px solid var\(--studio-tipBarEdge\);/);
  assert.match(bar, /background: var\(--studio-acc\);/);
  assert.equal(px(bar, 'min-height'), 48);
  // The bar is solid bg with a 1 px line on top (§6.5): the edge is proven on bg.
  const strip = declarations(
    css,
    ".studio[data-style='professional'] .tip-bar",
  );
  assert.match(strip, /background: var\(--studio-bg\);/);
  assert.match(strip, /border-top: 1px solid var\(--studio-line\);/);
  assert.match(strip, /backdrop-filter: none;/);
  // The tokens are on the page's root, from the registry: Amber light's edge is its own.
  const t = studioTokens('professional', 'amber').light;
  assert.notEqual(t.tipEdge, t.acc);
  const root = rootTag(professional({ accent: 'amber' }));
  assert.match(root, new RegExp(`--studio-tipEdge:${t.tipEdge}`));
  assert.match(root, new RegExp(`--studio-tipBarEdge:${t.tipBarEdge}`));
  // The phone's section title is the size the design check measures (ruling P3).
  assert.equal(
    px(
      declarations(css, ".studio[data-style='professional'] .studio-title"),
      'font-size',
    ),
    STUDIO_HEADING_PX.professional,
  );
});

// A text or quote block is a `studio-card` too (`studio-card studio-text`): the rising card's rules
// name it as the page's child (or the cover's next sibling), so none of them reaches a block.
test("Professional's card rules never reach a block's card", () => {
  const css = sheet('professional').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap(([, sel]) => sel.split(','))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /\.studio-card(?![\w-])/.test(s));
  assert.ok(selectors.length > 3, 'the card has rules');
  for (const s of selectors)
    assert.match(
      s,
      /(\.studio-page > \.studio-card|\+ \.studio-card)(?![\w-])/,
      s,
    );
  // The markup agrees: the rising card is the page's child; a block's card is not.
  const html = professional();
  const cover = inside(html, /<div class="studio-cover"/);
  assert.ok(html.includes(`${cover}<div class="studio-card">`));
  assert.match(html, /class="studio-card studio-text"/);
});
