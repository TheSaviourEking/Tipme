import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';

// The campaign Page tab's words (plan 2026-11-14 Task 7). Pure helpers, transpiled from TS.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const out = new URL(
  '../node_modules/.cache/campaign-editor-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });
const source = readFileSync(
  new URL(
    '../src/app/dashboard/campaigns/[id]/page-editor-text.ts',
    import.meta.url,
  ),
  'utf8',
);
writeFileSync(
  new URL('page-editor-text.mjs', out),
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
);
const { counterText, pageSummary, coverSummary } = await import(
  new URL('page-editor-text.mjs', out)
);

test('counterText counts code points, as the server does', () => {
  assert.equal(
    counterText('Thank you for dancing with me at Lagos Live', 60),
    '43 of 60',
  );
  assert.equal(counterText('', 200), '0 of 200');
  assert.equal(counterText('🎉🎉', 60), '2 of 60');
});

test('pageSummary names the cover, or "Same as page"', () => {
  assert.equal(coverSummary(null), 'Same as page');
  assert.equal(
    coverSummary({ design: 'scattered', colour: 'violet' }),
    'Scattered hearts, violet',
  );
  assert.equal(coverSummary({ design: 'dark', colour: null }), 'Dark');
  assert.equal(
    coverSummary({ design: null, animation: 'pulse', motion: 'loop' }),
    'Pulse, slow loop',
  );
  assert.equal(
    coverSummary({ design: null, animation: 'drift' }),
    'Drifting, plays once',
  );
  assert.equal(
    pageSummary({ on: false, headline: 'Hi', description: null, cover: null }),
    'Off: the link opens your normal page',
  );
  assert.equal(
    pageSummary({ on: true, headline: 'Hi', description: null, cover: null }),
    'On · Same as page',
  );
});
