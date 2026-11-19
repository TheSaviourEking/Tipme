import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Next 16 keeps the page someone moved on from mounted, hidden for the way back (React's Activity:
// an inline `display: none !important` on its top elements). A rule that reads the page from the
// outside, `html:has(.marker)`, `body:has(…)` or `:root:has(…)`, must read only the page on
// screen, or leaving a tip page would keep its header, logo size, colours and tokens on the next
// page (tests/e2e/soft-nav-chrome.spec.ts). Every such rule carries the same guard.
const GUARD =
  /^:not\(\s*\[style\*='display: none'\],\s*\[style\*='display: none'\] \*\s*\)/;

const SHEETS = [
  '../src/app/globals.css',
  '../src/app/dashboard/dashboard.css',
  '../src/app/ops/ops.css',
  ...[
    'frame',
    'classic',
    'clear',
    'horizon',
    'journal',
    'linen',
    'signboard',
    'sprint',
    'stage',
    'tiles',
  ].map((s) => `../src/components/studio-styles/${s}.css`),
];

/** State that isn't the page: the header's own open menu. */
const NOT_THE_PAGE = /^\.site-nav\b/;

test('every rule that reads the page from <html> or <body> reads only the page on screen', () => {
  let seen = 0;
  for (const sheet of SHEETS) {
    const css = readFileSync(new URL(sheet, import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const m of css.matchAll(
      /(?:^|[\s,{(])(?:html|body|:root)\s*:has\(\s*((?:main|dialog)?(?:[.#][\w-]+)*(?:\[[^\]]*\])*)/g,
    )) {
      const marker = m[1];
      if (!marker || NOT_THE_PAGE.test(marker)) continue;
      seen += 1;
      const after = css.slice(m.index + m[0].length);
      const line = css.slice(0, m.index).split('\n').length;
      assert.match(after, GUARD, `${sheet}:${line} ${marker}`);
    }
  }
  assert.ok(seen > 50, `${seen} page-reading rules`);
});
