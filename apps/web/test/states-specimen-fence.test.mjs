import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRIVATE_PATHS } from '../src/lib/seo.ts';

// The design system's States specimen shows the two proven money lines ("You haven’t paid
// anything", "back in your balance") as specimens. The states plan's money-safety test (Task 9)
// exempts that one file, so these fences keep the exemption narrow: the specimen stays on the
// unindexed design-system page, nothing else imports it, and it can't quietly gain more lines.
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const src = join(webRoot, 'src');
const specimenFile = join(src, 'app/design-system/states-specimen.tsx');
const pageFile = join(src, 'app/design-system/page.tsx');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

// Every way a module can pull the specimen in: `from '…'`, a side-effect `import '…'`, a dynamic
// `import('…')` (which next/dynamic uses) and `require('…')`.
const SPECIMEN = String.raw`['"\`][^'"\`]*states-specimen(?:\.[cm]?[jt]sx?)?['"\`]`;
const importsSpecimen = (text) =>
  new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)${SPECIMEN}`,
  ).test(text);

test('the fence sees every way of importing the specimen', () => {
  for (const text of [
    "import { StatesSpecimen } from './states-specimen';",
    "export * from '../design-system/states-specimen';",
    "import './states-specimen';",
    "const S = await import('./states-specimen');",
    "const S = dynamic(() => import(\n  './states-specimen.tsx'\n));",
    "const S = require('./states-specimen');",
    'const S = import(`./states-specimen`);',
  ])
    assert.ok(importsSpecimen(text), text);
  assert.equal(importsSpecimen("const name = 'states-specimen';"), false);
});

test('only the design-system page imports the states specimen', () => {
  const importers = sourceFiles(src)
    .filter((file) => file !== specimenFile)
    .filter((file) => importsSpecimen(readFileSync(file, 'utf8')))
    .map((file) => relative(src, file).split(sep).join('/'));
  assert.deepEqual(importers, ['app/design-system/page.tsx']);
});

test('the design-system page stays private and unindexed', () => {
  assert.ok(PRIVATE_PATHS.includes('/design-system'));
  const page = readFileSync(pageFile, 'utf8');
  assert.match(page, /export const metadata = previewMetadata\(/);
  assert.match(page, /'\/design-system',?\s*\)/);
});

// JSX may spell an apostrophe as an entity; count the words as a reader sees them.
const decode = (text) =>
  text
    .replace(/&(rsquo|lsquo|apos|#0*39|#0*8217|#x0*2019|#x0*27);/gi, '’')
    .replace(/&(nbsp|#0*160|#x0*a0);/gi, ' ')
    .replace(/&amp;/gi, '&');

test('entity spellings are decoded before the money lines are counted', () => {
  assert.equal(decode('haven&rsquo;t paid'), 'haven’t paid');
  assert.equal(decode('haven&#8217;t&nbsp;paid'), 'haven’t paid');
  assert.equal(decode('haven&#x2019;t paid'), 'haven’t paid');
});

test('the specimen holds exactly the expected money lines', () => {
  const specimen = decode(readFileSync(specimenFile, 'utf8'));
  const count = (pattern) => (specimen.match(pattern) ?? []).length;
  assert.equal(count(/haven[’']t\s+paid\s+anything/gi), 1);
  assert.equal(count(/back\s+in\s+your\s+balance/gi), 2);
  assert.equal(count(/money is safe|weren[’']t charged|refunded/gi), 0);
});
