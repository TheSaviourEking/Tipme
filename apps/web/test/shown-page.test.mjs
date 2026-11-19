import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { documentHasCount, pageGuardProblems } from './shown-page.mjs';

// Next 16 keeps the page someone moved on from mounted, hidden for the way back (React's Activity:
// an inline `display: none !important` on its top elements). A rule that reads the page from the
// document, `html:has(.marker)`, `body:has(…)`, `:root:has(…)`, must read only the page on
// screen, or leaving a tip page would keep its header, logo size, colours and tokens on the next
// page (tests/e2e/soft-nav-chrome.spec.ts). Every such rule carries the same guard.

const SRC = new URL('../src/', import.meta.url);
const SHEETS = readdirSync(SRC, { recursive: true })
  .filter((f) => f.endsWith('.css'))
  .sort();

const G =
  ":not([style*='display: none'], [style*='display:none'], [style*='display: none'] *, [style*='display:none'] *)";

test('every rule in every stylesheet that reads the page from the document reads only the page on screen', () => {
  assert.ok(SHEETS.length > 10, `${SHEETS.length} stylesheets`);
  let rules = 0;
  const problems = [];
  for (const sheet of SHEETS) {
    const css = readFileSync(new URL(sheet, SRC), 'utf8');
    rules += documentHasCount(css);
    problems.push(...pageGuardProblems(css, sheet));
  }
  assert.deepEqual(problems, []);
  assert.ok(rules > 50, `${rules} document :has() rules`);
});

test('the checker accepts a guarded rule, the allowed exception, and a guarded marker with more after it', () => {
  for (const css of [
    `html:has(.studio[data-style]${G}) .site-header { color: red; }`,
    `body:has(main[data-area='recipient']${G}) > .site-footer { color: red; }`,
    `html[data-x]:has(.a${G}, .b${G}) { color: red; }`,
    `html:has(.profile-page${G} .composer-action) .x { color: red; }`,
    `body:has(.site-nav.is-open) { overflow: hidden; }`,
    `.card:has(> input:checked) { color: red; }`,
  ])
    assert.deepEqual(pageGuardProblems(css), [], css);
});

test('the checker fails a rule it cannot prove guarded', () => {
  const fails = (css, why) => {
    const problems = pageGuardProblems(css);
    assert.ok(problems.length > 0, `passed: ${css}`);
    assert.ok(
      problems.some((p) => p.includes(why)),
      `${css}: ${problems.join('; ')}`,
    );
  };
  // An element and a class, unguarded: read, not skipped.
  fails('html:has(section.foo) { color: red; }', 'no guard on section.foo');
  // A marker inside :is(): not one the checker can read.
  fails(
    'html:has(:is(.a,.b)) { color: red; }',
    "a marker the checker can't read",
  );
  // A list: each compound is checked, not only the first.
  fails('html:has(.a:not(x), .b) { color: red; }', 'no guard on .a');
  fails(`html:has(.a${G}, .b) { color: red; }`, 'no guard on .b');
  // The document written as :is(html, body).
  fails(':is(html,body):has(.x) { color: red; }', 'no guard on .x');
  // Half a guard: the no-space form missing.
  fails(
    "html:has(.x:not([style*='display: none'], [style*='display: none'] *)) { color: red; }",
    'no guard on .x',
  );
  // Empty.
  fails('body:has( ) { color: red; }', "a marker the checker can't read");
});

test('the checker reads every stylesheet, not a list: an unguarded rule in any file fails', () => {
  // A sheet no hand-kept list ever named; the glob above reads it as it reads the rest.
  assert.ok(SHEETS.some((f) => f.endsWith('studio-editor.css')));
  assert.ok(SHEETS.some((f) => f.includes('ops')));
  const css = `${readFileSync(
    new URL(
      SHEETS.find((f) => f.endsWith('studio-editor.css')),
      SRC,
    ),
    'utf8',
  )}
html:has(.pst-frame[data-frame='desktop']) .site-header { display: none; }`;
  assert.deepEqual(
    pageGuardProblems(css, 'studio-editor.css').map((p) =>
      p.replace(/:\d+ /, ' '),
    ),
    [
      "studio-editor.css .pst-frame[data-frame='desktop']: no guard on .pst-frame[data-frame='desktop']",
    ],
  );
});
