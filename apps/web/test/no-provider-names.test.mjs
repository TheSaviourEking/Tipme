import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
// Provider ids the code compares and never shows, matched against a literal's whole text. These
// are the only provider-id literals in the scanned files today.
const allowedIds = new Set(['bachs-live', 'bachs-sandbox']);
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

const kinds = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
};

// The text a user could read: string and template literals, JSX text and string JSX attributes.
// The TypeScript parser drops comments and never reads identifiers as text, so neither can hide
// or cause a hit, and a '//' or '/*' inside a string cannot swallow code.
export function visibleProviderNames(code, ext = '.tsx') {
  if (!(ext in kinds))
    return code.split('\n').filter((line) => /\bbachs\b/i.test(line));
  const source = ts.createSourceFile(
    `file${ext}`,
    code,
    ts.ScriptTarget.Latest,
    true,
    kinds[ext],
  );
  const hits = [];
  const check = (text) => {
    if (/\bbachs\b/i.test(text) && !allowedIds.has(text))
      hits.push(text.trim());
  };
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    )
      check(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

test('the guard catches names in strings and JSX text, next to expressions too', () => {
  for (const code of [
    "const a = 'Pay via Bachs';",
    'const a = `Bachs ${x}`;',
    '<p>Set up with Bachs</p>',
    '<p>Powered by Bachs {x}</p>',
    '<p>{count} tips via Bachs</p>',
    '<p>{a} Bachs {b}</p>',
    "const sep = ' // '; const label = 'Bachs';",
    "const a = '/*'; const m = 'Bachs'; const b = '*/';",
    '<p title="Bachs">x</p>',
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
    'const k = `bachs-live`;',
    "const s = 'a'; /* Bachs */ // Bachs here\nconst t = 1;",
  ])
    assert.equal(visibleProviderNames(code).length, 0, code);
});

test('no user-readable source text names a payment provider', () => {
  const offenders = [];
  for (const file of [...roots.flatMap(sourceFiles), ...extraFiles]) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    if (exempt.some((e) => rel.startsWith(e))) continue;
    for (const hit of visibleProviderNames(
      readFileSync(file, 'utf8'),
      extname(file),
    ))
      offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});
