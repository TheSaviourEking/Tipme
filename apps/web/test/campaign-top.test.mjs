import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// CampaignTop (plan 2026-11-14 Task 6) is TSX: transpiled with the project's TypeScript into a
// cache folder inside the app, so `react` resolves as it does for the app, then rendered to HTML.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const out = new URL(
  '../node_modules/.cache/campaign-top-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });
const text = readFileSync(
  new URL('../src/components/profile/campaign-top.tsx', import.meta.url),
  'utf8',
);
writeFileSync(
  new URL('campaign-top.mjs', out),
  ts.transpileModule(text, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
);
const { CampaignTop } = await import(new URL('campaign-top.mjs', out));
const { renderToStaticMarkup } = require('react-dom/server');
const { createElement } = require('react');

const render = (page) =>
  renderToStaticMarkup(createElement(CampaignTop, { page }));

test('campaign top renders the headline as text, never HTML', () => {
  const html = render({
    slug: 'gig',
    headline: '<b>x</b>',
    description: '<img src=x onerror=alert(1)>',
  });
  assert.equal(html.includes('<b>'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<section[^>]*aria-labelledby="campaign-headline"/);
  assert.match(
    html,
    /<h2 id="campaign-headline"[^>]*>&lt;b&gt;x&lt;\/b&gt;<\/h2>/,
  );
});

test('no description, no paragraph', () => {
  const html = render({ slug: 'gig', headline: 'Thank you for coming' });
  assert.equal(html.includes('<p'), false);
  assert.match(html, />Thank you for coming<\/h2>/);
});
