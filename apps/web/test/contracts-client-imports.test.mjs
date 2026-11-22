import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as barrel from '@tipme/contracts';
import * as copy from '@tipme/contracts/copy';

// The public tip page must not ship the contracts barrel (its zod schemas): a value import of it
// from the tip form added ~130 kB to every public page (PR #316, studio first-load weight check).
// Words a client needs come from the dependency-free `@tipme/contracts/copy`; types are free.
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The value names a file imports from the barrel itself (not a subpath); type-only imports skip. */
function barrelValues(source) {
  const names = [];
  const statement =
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'@tipme\/contracts'/g;
  for (const [, typeOnly, list] of source.matchAll(statement)) {
    if (typeOnly) continue;
    for (const part of list.split(',').map((p) => p.trim()))
      if (part && !part.startsWith('type ')) names.push(part);
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*'@tipme\/contracts'/.test(source))
    names.push('*');
  return names;
}

/** Every client component the public tip page renders from the tip form down. */
const PUBLIC_TIP_FORM = ['src/components/appreciation-form.tsx'];

test('the public tip form imports no values from the contracts barrel', () => {
  for (const file of PUBLIC_TIP_FORM) {
    const source = readFileSync(join(webRoot, file), 'utf8');
    assert.deepEqual(barrelValues(source), [], file);
  }
});

test('COLLECT_COPY is imported from @tipme/contracts/copy everywhere in the web app', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) {
        const values = barrelValues(readFileSync(path, 'utf8'));
        if (values.includes('COLLECT_COPY'))
          offenders.push(relative(webRoot, path));
      }
    }
  };
  walk(join(webRoot, 'src'));
  assert.deepEqual(offenders, []);
});

test('@tipme/contracts/copy imports nothing, and the barrel re-exports the same words', () => {
  const built = readFileSync(
    join(repoRoot, 'packages/contracts/dist/copy.js'),
    'utf8',
  );
  assert.doesNotMatch(built, /^\s*(import|export\s.*\sfrom)\s/m);
  assert.equal(barrel.COLLECT_COPY, copy.COLLECT_COPY);
});

test('the guard sees value imports and lets type-only ones through', () => {
  assert.deepEqual(
    barrelValues(
      "import type { A } from '@tipme/contracts';\nimport { type B, c } from '@tipme/contracts';\nimport { D } from '@tipme/contracts/copy';",
    ),
    ['c'],
  );
});
