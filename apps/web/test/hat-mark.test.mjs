import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The account menu's mark (owner, 16 Nov 2026): the person's photo for their page, the business's
// logo for a business or workplace, the initial only without one. HatMark is TSX with the `@/`
// alias, so it is transpiled with the project's TypeScript into a cache folder inside the app
// (as cover-component.test.mjs does), with imports pointed at that folder.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const src = new URL('../src/', import.meta.url);
const out = new URL('../node_modules/.cache/hat-mark-test/', import.meta.url);
mkdirSync(out, { recursive: true });

function build(name, from, rewrites = {}) {
  let js = ts.transpileModule(readFileSync(new URL(from, src), 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const [from, to] of Object.entries({
    '@/lib/avatar-source': './avatar-source.mjs',
    '@/components/avatar': './avatar.mjs',
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
build('avatar.mjs', 'components/avatar.tsx');
build('hat-mark.mjs', 'components/dashboard/hat-mark.tsx');
// The same component with `react` swapped for a one-slot useState, so a logo failing to load can
// be driven without a browser.
build('hat-mark-stub.mjs', 'components/dashboard/hat-mark.tsx', {
  react: './react-stub.mjs',
});
writeFileSync(
  new URL('react-stub.mjs', out),
  `let slot; let has = false;
export const useState = (init) => { if (!has) { slot = init; has = true; } return [slot, (v) => { slot = v; }]; };
export const reset = () => { has = false; slot = undefined; };
`,
);

const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');
const { HatMark } = await import(new URL('hat-mark.mjs', out));
const stub = await import(new URL('hat-mark-stub.mjs', out));
const react = await import(new URL('react-stub.mjs', out));

const LOGO = 'http://127.0.0.1:4000/v1/business-logos/b-1/3.webp';
const mark = (props) => renderToStaticMarkup(createElement(HatMark, props));

test('a business with a logo shows it, decorative, at the mark’s fixed size', () => {
  const html = mark({ initialOf: 'Lagoon Bakery', logo: LOGO, name: 'Ada' });
  assert.match(html, /data-mark="logo"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(
    html,
    /<img class="hat-menu__photo" src="http:\/\/127\.0\.0\.1:4000\/v1\/business-logos\/b-1\/3\.webp" alt="" width="32" height="32"\/>/,
  );
  assert.doesNotMatch(html, />L</);
});

test('a business without a logo shows its initial, and nothing is fetched', () => {
  const html = mark({ initialOf: 'Lagoon Bakery', logo: null, name: 'Ada' });
  assert.match(html, /data-mark="initial"/);
  assert.match(html, />L<\/span>$/);
  assert.doesNotMatch(html, /<img/);
});

test('the page shows the person’s photo; an @username’s initial skips the @', () => {
  const photo = mark({
    initialOf: '@ada',
    photo: '/v1/avatars/a-1/2.webp',
    name: 'Ada',
  });
  assert.match(photo, /data-mark="photo"/);
  assert.match(photo, /\/v1\/avatars\/a-1\/2\.webp/);
  const none = mark({ initialOf: '@ada', name: 'Ada' });
  assert.match(none, />A<\/span>$/);
});

test('a logo that fails to load falls back to the initial', () => {
  react.reset();
  const props = { initialOf: 'Lagoon Bakery', logo: LOGO, name: 'Ada' };
  const first = stub.HatMark(props);
  assert.equal(first.props['data-mark'], 'logo');
  first.props.children.props.onError();
  const after = stub.HatMark(props);
  assert.equal(after.props['data-mark'], 'initial');
  assert.equal(after.props.children, 'L');
  // A new logo is tried again.
  const next = stub.HatMark({ ...props, logo: `${LOGO}?v=4` });
  assert.equal(next.props['data-mark'], 'logo');
});
