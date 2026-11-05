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
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('only the design-system page imports the states specimen', () => {
  const importers = sourceFiles(src)
    .filter((file) => file !== specimenFile)
    .filter((file) =>
      /from ['"][^'"]*states-specimen['"]/.test(readFileSync(file, 'utf8')),
    )
    .map((file) => relative(src, file).split(sep).join('/'));
  assert.deepEqual(importers, ['app/design-system/page.tsx']);
});

test('the design-system page stays private and unindexed', () => {
  assert.ok(PRIVATE_PATHS.includes('/design-system'));
  const page = readFileSync(pageFile, 'utf8');
  assert.match(page, /export const metadata = previewMetadata\(/);
  assert.match(page, /'\/design-system',?\s*\)/);
});

test('the specimen holds exactly the expected money lines', () => {
  const specimen = readFileSync(specimenFile, 'utf8');
  const count = (pattern) => (specimen.match(pattern) ?? []).length;
  assert.equal(count(/haven[’']t\s+paid\s+anything/gi), 1);
  assert.equal(count(/back\s+in\s+your\s+balance/gi), 2);
  assert.equal(count(/money is safe|weren[’']t charged|refunded/gi), 0);
});
