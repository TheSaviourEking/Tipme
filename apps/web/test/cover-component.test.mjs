import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// ProfileCover is TSX and uses the `@/` alias, which node can't load as it is. Each file is
// transpiled with the project's own TypeScript into a cache folder inside the app (so `react`
// and `@tipme/contracts` resolve as they do for the app), with imports pointed at that folder.
// `next/image` is the real one: its server output is what a visitor's first HTML holds.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const src = new URL('../src/', import.meta.url);
const out = new URL('../node_modules/.cache/cover-test/', import.meta.url);
mkdirSync(out, { recursive: true });

function build(name, from, rewrites = {}) {
  const text = readFileSync(new URL(from, src), 'utf8');
  let js = ts.transpileModule(text, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const [from, to] of Object.entries({
    '@/lib/avatar-source': './avatar-source.mjs',
    '@/lib/cover-view': './cover-view.mjs',
    './cover-image': './cover-image.mjs',
    'next/image': './next-image.mjs',
    ...rewrites,
  }))
    js = js
      .replaceAll(`"${from}"`, `"${to}"`)
      .replaceAll(`'${from}'`, `'${to}'`);
  writeFileSync(new URL(name, out), js);
}
writeFileSync(
  new URL('next-image.mjs', out),
  "import image from 'next/image.js';\nexport default image.default ?? image;\n",
);
build('avatar-source.mjs', 'lib/avatar-source.ts');
build('cover-view.mjs', 'lib/cover-view.ts');
build('cover-image.mjs', 'components/profile/cover-image.tsx');
build('cover.mjs', 'components/profile/cover.tsx');
// The same client component, with `react` swapped for a one-slot useState, so its onError
// handling can be driven without a browser.
build('cover-image-stub.mjs', 'components/profile/cover-image.tsx', {
  react: './react-stub.mjs',
});
writeFileSync(
  new URL('react-stub.mjs', out),
  `let slot; let has = false;
export const useState = (init) => { if (!has) { slot = init; has = true; } return [slot, (v) => { slot = v; }]; };
export const reset = () => { has = false; slot = undefined; };
`,
);

// What next.config.ts sets for images, on top of Next's defaults (the config file itself pulls in
// Sentry, so it can't be loaded here; the last test pins that it says this).
const { imageConfigDefault } = require('next/dist/shared/lib/image-config.js');
const {
  ImageConfigContext,
} = require('next/dist/shared/lib/image-config-context.shared-runtime.js');
const siteImages = { ...imageConfigDefault, qualities: [75, 85] };

const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');
const { ProfileCover } = await import(new URL('cover.mjs', out));
const stub = await import(new URL('cover-image-stub.mjs', out));
const react = await import(new URL('react-stub.mjs', out));

const onSite = (...children) =>
  createElement(
    ImageConfigContext.Provider,
    { value: siteImages },
    ...children,
  );
const html = (cover, priority) =>
  renderToStaticMarkup(
    onSite(createElement(ProfileCover, { cover, priority })),
  );

test('a heart cover is drawn inline, hidden from assistive technology, with its frame', () => {
  const markup = html({ kind: 'design', design: 'large', colour: 'violet' });
  assert.match(markup, /class="profile-cover"/);
  assert.match(markup, /data-profile-cover="large"/);
  assert.match(markup, /<svg[^>]*aria-hidden="true"/);
  assert.match(markup, /preserveAspectRatio="xMidYMid slice"/);
  // The frame paints its colour before anything else, and nothing is fetched.
  assert.match(markup, /style="background:#7a32f9"/);
  assert.doesNotMatch(markup, /<img|<script|href=/);
});

test('an image cover has an empty alt, fills its reserved frame, and is in the first HTML', () => {
  const markup = html({ kind: 'design', design: 'danfo' }, true);
  assert.match(markup, /<img[^>]*alt=""/);
  assert.match(markup, /data-profile-cover="image"/);
  assert.match(markup, /loading="eager"/);
  assert.match(markup, /fetchPriority="high"|fetchpriority="high"/);
  assert.match(markup, /sizes="100vw"/);
  // Optimised at quality 85, not the default 75, so art isn't squeezed twice.
  assert.match(markup, /q=85/);
  assert.doesNotMatch(markup, /q=75/);
  // Priority also puts a preload in the head, so the picture is found before the page's CSS.
  assert.match(markup, /<link rel="preload" as="image"/);
  assert.match(markup, /covers%2Fdanfo\.webp/);
  const later = html({ kind: 'design', design: 'danfo' });
  assert.doesNotMatch(later, /fetchPriority="high"|fetchpriority="high"/);
  assert.match(later, /loading="lazy"/);
});

test('a photo is not optimised and comes from the API', () => {
  const markup = html({ kind: 'photo', path: '/v1/covers/ab-1/2.webp' });
  assert.match(markup, /\/v1\/covers\/ab-1\/2\.webp/);
  assert.doesNotMatch(markup, /_next\/image/);
});

test('two tiled covers on one page get different pattern ids', () => {
  const together = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ProfileCover, {
        cover: { kind: 'design', design: 'scattered', colour: 'neutral' },
      }),
      createElement(ProfileCover, {
        cover: { kind: 'design', design: 'outline', colour: 'rose' },
      }),
    ),
  );
  const pair = [...together.matchAll(/<pattern id="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0], pair[1]);
  for (const id of pair) assert.ok(together.includes(`url(#${id})`));
});

test('when the image fails to load, the automatic look takes its place, and only for that source', () => {
  react.reset();
  const props = {
    src: '/covers/danfo.webp',
    unoptimized: false,
    fallback: 'FALLBACK',
  };
  const first = stub.CoverImage(props);
  assert.equal(first.props.alt, '');
  first.props.onError();
  const second = stub.CoverImage(props);
  assert.equal(second.props.children, 'FALLBACK');
  // A different cover (a new choice in an editor) gets to try its own picture.
  const other = stub.CoverImage({ ...props, src: '/covers/vinyl.webp' });
  assert.equal(other.props.alt, '');
});

test('the site config allows the quality the covers ask for', () => {
  assert.match(
    readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8'),
    /qualities: \[75, 85\]/,
  );
});

const animatedHtml = (cover, animate) =>
  renderToStaticMarkup(onSite(createElement(ProfileCover, { cover, animate })));
const night = { kind: 'animated', animation: 'night', play: 'loop' };

test('an animated cover renders five decorative layers in the server HTML', () => {
  const markup = animatedHtml(night, true);
  assert.equal(markup.match(/class="cover-fx cover-fx--night"/g)?.length, 5);
  assert.equal(markup.match(/<span[^>]*aria-hidden="true"/g)?.length, 5);
  assert.match(markup, /data-profile-cover="animated:night"/);
  assert.match(markup, /style="background:#101a3a"/);
  assert.doesNotMatch(markup, /<script|<img|href=/);
  assert.doesNotMatch(markup, /will-change/);
});

test('play once, loop and still are carried to the markup', () => {
  for (const play of ['once', 'loop', 'still'])
    assert.match(
      animatedHtml({ ...night, play }, true),
      new RegExp(`data-cover-play="${play}"`),
    );
});

test('without animate, an animated cover renders still (thumbnails, stamps, staff screens)', () => {
  assert.match(animatedHtml(night, false), /data-cover-play="still"/);
  assert.match(animatedHtml(night), /data-cover-play="still"/);
});

test('a Pro colour replaces the palette; no colour uses the palette', () => {
  const ocean = animatedHtml({ ...night, colour: 'ocean' }, true);
  assert.match(ocean, /background:#1d4e89/);
  assert.match(ocean, /color:#3a79c2/);
  const own = animatedHtml(night, true);
  assert.match(own, /color:#3e5aa8/);
});

test('an unknown cover kind draws the automatic cover', () => {
  const markup = animatedHtml({ kind: 'hologram' }, true);
  assert.match(markup, /data-profile-cover="scattered"/);
  assert.doesNotMatch(markup, /cover-fx/);
});

test('the stylesheet animates only transform and opacity, and stills cover-fx under reduced motion, forced colours and print', () => {
  const css = readFileSync(new URL('app/globals.css', src), 'utf8');
  const frames = [...css.matchAll(/@keyframes (cover-fx-[a-z]+)\s*\{/g)];
  assert.equal(frames.length, 6);
  for (const match of frames) {
    let depth = 0;
    let i = css.indexOf('{', match.index);
    const start = i;
    do {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    } while (depth > 0);
    const body = css.slice(start, i);
    const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(properties.length > 0, match[1]);
    for (const property of properties)
      assert.ok(
        ['transform', 'opacity'].includes(property),
        `${match[1]}: ${property}`,
      );
  }
  for (const query of [
    '@media (prefers-reduced-motion: reduce)',
    '@media (forced-colors: active)',
    '@media print',
  ]) {
    const at = css.indexOf(query, css.indexOf('.cover-fx {'));
    assert.ok(at > 0, query);
    const block = css.slice(at, css.indexOf('\n}\n', at));
    assert.match(block, /\.cover-fx\s*\{[^}]*animation:\s*none/, query);
  }
});
