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
// API provider ids are compared, never shown: 'bachs-sandbox' and 'bachs-live'.
const providerId = /(['"`])bachs-(?:sandbox|live)\1/gi;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) &&
      !/\.test\.[a-z]+$/.test(name) &&
      !path.includes(`${sep}__tests__${sep}`)
      ? [path]
      : [];
  });
}

// Drops comments but keeps string contents; a quote inside a comment or a // inside a string
// (https://...) must not confuse it, so strings are walked as units.
export function stripComments(code) {
  let out = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Lines that carry a provider name inside quotes or as JSX text. Identifiers have no quote or
// tag boundary around them, so they never match.
export function visibleProviderNames(code) {
  const text = stripComments(code).replace(providerId, '');
  const hits = [];
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g))
    if (/\bbachs\b/i.test(m[2])) hits.push(m[2]);
  for (const m of text.matchAll(/>([^<>{}]*)</g))
    if (/\bbachs\b/i.test(m[1])) hits.push(m[1].trim());
  return hits;
}

test('the guard sees names in strings and JSX text, not in identifiers or comments', () => {
  assert.equal(visibleProviderNames("const a = 'Pay via Bachs';").length, 1);
  assert.equal(visibleProviderNames('const a = `Bachs ${x}`;').length, 1);
  assert.equal(visibleProviderNames('<p>Set up with Bachs</p>').length, 1);
  assert.equal(visibleProviderNames("if (p === 'bachs-live') {}").length, 0);
  assert.equal(
    visibleProviderNames('// Bachs\n/* Bachs */ const t: BachsStatus = 1;')
      .length,
    0,
  );
  assert.equal(
    visibleProviderNames("fetch('https://x.io'); // it's Bachs").length,
    0,
  );
});

test('no user-readable source text names a payment provider', () => {
  const offenders = [];
  for (const root of roots)
    for (const file of sourceFiles(root)) {
      const rel = relative(repoRoot, file).split(sep).join('/');
      if (exempt.some((e) => rel.startsWith(e))) continue;
      for (const hit of visibleProviderNames(readFileSync(file, 'utf8')))
        offenders.push(`${rel}: ${hit}`);
    }
  assert.deepEqual(offenders, []);
});
