import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The header's "Business" row: "Coming soon" pill only while business sign-up is off, and none while
// the flag is still being read. The components are TSX, so they are transpiled into a cache folder
// inside the app (as hat-mark.test.mjs does), with imports pointed at that folder.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const src = new URL('../src/components/', import.meta.url);
const out = new URL(
  '../node_modules/.cache/business-who-text-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });

function build(name, from) {
  const js = ts
    .transpileModule(readFileSync(new URL(from, src), 'utf8'), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replaceAll("'../who-words'", "'./who-words.mjs'")
    .replaceAll('"../who-words"', '"./who-words.mjs"');
  writeFileSync(new URL(name, out), js);
}
build('who-words.mjs', 'who-words.tsx');
build('business-who-text.mjs', 'business/business-who-text.tsx');

const { createElement } = require('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { BusinessesWhoText, BusinessesWhoPending } = await import(
  new URL('business-who-text.mjs', out).href
);

const words = 'Receive and manage tips for businesses and their employees.';

test('with business sign-up off the row says Coming soon, beside the title', () => {
  const html = renderToStaticMarkup(
    createElement(BusinessesWhoText, { on: false }),
  );
  assert.match(html, /<strong>Business<\/strong>/);
  assert.match(html, /<span class="who__soon">Coming soon<\/span>/);
  assert.ok(html.includes(words));
  assert.ok(html.indexOf('Coming soon') < html.indexOf(words));
});

test('with business sign-up on there is no pill', () => {
  const html = renderToStaticMarkup(
    createElement(BusinessesWhoText, { on: true }),
  );
  assert.match(html, /<strong>Business<\/strong>/);
  assert.doesNotMatch(html, /Coming soon|who__soon/);
  assert.ok(html.includes(words));
});

test('while the flag is being read there is no pill either', () => {
  const html = renderToStaticMarkup(createElement(BusinessesWhoPending));
  assert.doesNotMatch(html, /Coming soon/);
  assert.ok(html.includes(words));
});
