import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_FONTS,
  STUDIO_HEADING_PX,
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
  // Classic is tested in studio-classic.test.mjs.
  './classic': './stub-classic.mjs',
  '@/components/profile/standard-profile': './stub-standard-profile.mjs',
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
const sheet = (style) => readFileSync(new URL(`${style}.css`, src), 'utf8');
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
    // The cover's own height is the one StyleCover sizes its photo for (phone, desktop).
    assert.equal(
      px(declarations(css, `.studio[data-style='${style}']`), '--tall'),
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
      ),
      STYLE_COVER[style].desktopTall,
    );
  }
  assert.deepEqual(STYLE_COVER.stage, { tall: 488, desktopTall: 640 });
  assert.deepEqual(STYLE_COVER.horizon, { tall: 640, desktopTall: 836 });
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
  const frame = readFileSync(new URL('frame.css', src), 'utf8');
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
