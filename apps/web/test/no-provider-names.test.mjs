import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Owner rule (1 Nov 2026): users never see a payment provider's name. TipMe's own words say
// "our payment partner". Staff screens (/ops) and test-only screens may name providers.
// Identifiers (BachsPaymentAccountStatus) and comments are fine; text a user can read is not.
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(webRoot, '..', '..');
const roots = [join(webRoot, 'src'), join(repoRoot, 'packages/mail/src')];

const exempt = [
  'apps/web/src/app/ops/',
  'apps/web/src/lib/ops-client.ts',
  'apps/web/src/app/mock-checkout/',
  'apps/web/src/app/dev/',
  'apps/web/src/app/preview-login/',
];
// Provider ids the code compares and never shows. Each allowed literal is listed explicitly.
const allowedIds = [
  "'bachs-live'",
  "'bachs-sandbox'",
  '"bachs-live"',
  '"bachs-sandbox"',
];
// Staff-only text is out of scope on purpose: /ops, ops-client.ts and operator summaries such as
// packages/database/src/operations/issues.ts may name providers.
const extraFiles = [
  join(repoRoot, 'apps/api/src/http/api-exception.filter.ts'),
];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs|json|md|mdx)$/.test(name) &&
      !/\.test\.[a-z]+$/.test(name) &&
      !path.includes(`${sep}__tests__${sep}`)
      ? [path]
      : [];
  });
}

// Drops comments only: block comments, and // at a line start or after whitespace (so the // in
// https:// stays). Everything else is scanned as plain text, so quotes, apostrophes in JSX text and
// regex literals cannot shift anything.
export function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// Every provider name left in the text. `\b` already skips identifiers such as
// BachsPaymentAccountStatus; the listed provider-id literals are removed first.
export function visibleProviderNames(code) {
  let text = stripComments(code);
  for (const id of allowedIds) text = text.split(id).join('');
  return [...text.matchAll(/.*\bbachs\b.*/gi)].map((m) => m[0].trim());
}

test('the guard catches names in strings and JSX text, next to expressions too', () => {
  for (const code of [
    "const a = 'Pay via Bachs';",
    'const a = `Bachs ${x}`;',
    '<p>Set up with Bachs</p>',
    '<p>Powered by Bachs {x}</p>',
    '<p>{count} tips via Bachs</p>',
    '<p>{a} Bachs {b}</p>',
    '<p>\n  Paid by\n  {name} through Bachs\n</p>',
    "<p>We can't pay you</p>;\nconst m = 'Bachs';",
    "const r = /['\"]/; const m = 'Bachs';",
    "fetch('https://x.io'); const m = 'Bachs';",
  ])
    assert.equal(visibleProviderNames(code).length, 1, code);
});

test('the guard allows identifiers, provider ids and comments', () => {
  for (const code of [
    "if (p === 'bachs-live') {}",
    'const k = "bachs-sandbox";',
    'const t: BachsStatus = 1; import { BachsPaymentAccountStatus } from "x";',
    '// Bachs\n/* Bachs */ const a = 1;',
    '{/* Bachs */}',
    "fetch('https://x.io'); // it's Bachs",
    'const bachsAccount = 1;',
  ])
    assert.equal(visibleProviderNames(code).length, 0, code);
});

test('no user-readable source text names a payment provider', () => {
  const offenders = [];
  for (const file of [...roots.flatMap(sourceFiles), ...extraFiles]) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    if (exempt.some((e) => rel.startsWith(e))) continue;
    for (const hit of visibleProviderNames(readFileSync(file, 'utf8')))
      offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});
