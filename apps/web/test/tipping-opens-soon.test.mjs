import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The closed card is TSX, which node cannot load: compile just this file, pointing its one local
// import at the TypeScript source (node strips its types), and render it on the server.
const source = new URL(
  '../src/components/tipping-opens-soon.tsx',
  import.meta.url,
);
const copy = new URL('../src/lib/payment-mode-copy.ts', import.meta.url);
const compile = (file) =>
  ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
// Inside apps/web, so react and @tipme/ui resolve from its node_modules.
const outDir = fileURLToPath(
  new URL('../node_modules/.cache/tipme-test/', import.meta.url),
);
mkdirSync(outDir, { recursive: true });
const compiled = `${outDir}tipping-opens-soon.mjs`;
writeFileSync(
  `${outDir}share-profile.mjs`,
  compile(new URL('../src/components/share-profile.tsx', import.meta.url)),
);
writeFileSync(
  compiled,
  compile(source)
    .replace("'@/lib/payment-mode-copy'", `'${copy.href}'`)
    .replace("'./share-profile'", "'./share-profile.mjs'"),
);
const { TippingOpensSoon } = await import(pathToFileURL(compiled).href);

test('the closed card says tipping opens soon, with no pay button', () => {
  const html = renderToStaticMarkup(createElement(TippingOpensSoon));
  assert.match(html, /<h2[^>]*>Tipping opens soon<\/h2>/);
  assert.doesNotMatch(html, /<button|<form/);
  assert.doesNotMatch(html, /test|sandbox|no real money/i);
});

test('on a person’s page it offers the page link, and still no way to pay', () => {
  const html = renderToStaticMarkup(
    createElement(TippingOpensSoon, { handle: 'kemi' }),
  );
  assert.match(html, /<button[^>]*>Copy page link<\/button>/);
  assert.doesNotMatch(html, /<form|type="submit"/);
});

test('closing after a refusal is announced: a polite live region and a focusable heading', () => {
  const html = renderToStaticMarkup(
    createElement(TippingOpensSoon, { announce: true }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /<h2[^>]*tabindex="-1"[^>]*>Tipping opens soon<\/h2>/);
});

test('shown from the start (not after a refusal) it takes no focus and stays quiet', () => {
  const html = renderToStaticMarkup(createElement(TippingOpensSoon));
  assert.doesNotMatch(html, /role="status"|tabindex/);
});
