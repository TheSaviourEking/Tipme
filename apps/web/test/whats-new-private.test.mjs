import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Changelog plan (5 Nov 2026), Task 6.4: What's new lives inside the dashboard only. Nothing the
// public page, the tip form or a tip's status page draws may reach it, directly or through another
// module. A failure here is a leak: fix the import, not this test.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const PUBLIC_ROOTS = [
  'app/people',
  'app/tip',
  'app/[handle]',
  'components/appreciation-form.tsx',
  'components/profile',
].map((path) => join(SRC, path));

const SOURCE = /\.(tsx?|mjs|js)$/;

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** A module path as written in an import, resolved to a file under src, or null (a package). */
function resolveImport(from, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every source file the public roots reach, with the chain that reached it. */
function reachable() {
  const seen = new Map();
  const queue = PUBLIC_ROOTS.flatMap(filesUnder).map((file) => [file, []]);
  while (queue.length > 0) {
    const [file, chain] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, chain);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const next = resolveImport(file, match[1] ?? match[2]);
      if (next && !seen.has(next)) queue.push([next, [...chain, file]]);
    }
  }
  return seen;
}

test('the public roots exist, so this test is really looking at something', () => {
  assert.ok(PUBLIC_ROOTS.filter(existsSync).length >= 3);
  assert.ok(reachable().size > 10);
});

test('nothing on public pages or the tip form imports What’s new or calls its routes', () => {
  const leaks = [];
  for (const [file, chain] of reachable()) {
    const text = readFileSync(file, 'utf8');
    const name = relative(SRC, file);
    if (
      /whats-new/i.test(name) ||
      /\/v1\/me\/whats-new|whats-new['"]/.test(text)
    )
      leaks.push(
        [...chain.map((step) => relative(SRC, step)), name].join(' → '),
      );
  }
  assert.deepEqual(leaks, []);
});

test('the dashboard does use it, so the check above would see an import', () => {
  const shell = readFileSync(
    join(SRC, 'app/dashboard/dashboard-shell.tsx'),
    'utf8',
  );
  assert.match(shell, /whats-new/);
});
