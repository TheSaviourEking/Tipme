import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The bar's notice slot is the one copy a phone shows (and a screen reader hears), so it is not
// hidden from assistive technology; the copy in the panel is removed by CSS on the same phones.
// The bar's notice slot takes whatever notice the form holds, so a later notice (the live pilot
// notice) reaches it without changing the bar. TSX: compile this one file and render it.
const source = new URL('../src/components/tip-action.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(source, 'utf8'), {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const outDir = fileURLToPath(
  new URL('../node_modules/.cache/tipme-test/', import.meta.url),
);
mkdirSync(outDir, { recursive: true });
const compiled = `${outDir}tip-action.mjs`;
writeFileSync(compiled, outputText);
const { TipAction } = await import(pathToFileURL(compiled).href);

test('a notice node of any kind sits directly above the button', () => {
  const html = renderToStaticMarkup(
    createElement(
      TipAction,
      {
        notice: createElement('span', { id: 'stand-in' }, 'Pilot terms apply.'),
        quote: createElement('p', null, 'You pay'),
      },
      createElement('button', null, 'Tip'),
    ),
  );
  assert.match(
    html,
    /<p>You pay<\/p><p class="composer-action__notice"><span id="stand-in">Pilot terms apply\.<\/span><\/p><button>/,
  );
});

test('the partner line sits directly under the button', () => {
  const html = renderToStaticMarkup(
    createElement(
      TipAction,
      { partner: 'A partner handles this.' },
      createElement('button', null, 'Tip'),
    ),
  );
  assert.match(
    html,
    /<button>Tip<\/button><p class="composer-action__partner">A partner handles this\.<\/p>/,
  );
});

test('no notice, no slot', () => {
  const html = renderToStaticMarkup(
    createElement(TipAction, null, createElement('button', null, 'Tip')),
  );
  assert.doesNotMatch(html, /composer-action__notice/);
  assert.match(
    html,
    /<div class="composer-action"><button>Tip<\/button><\/div>/,
  );
});
