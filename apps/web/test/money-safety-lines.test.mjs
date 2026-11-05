import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A reassuring money line may appear only where the code proves it (states plan, "Money-safety
// proofs"). The design system's specimen shows the proven lines too; states-specimen-fence.test.mjs
// keeps that exemption narrow.
const src = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}
// Straight or curly apostrophe, and the HTML entities JSX allows.
const decode = (text) =>
  text
    .replaceAll(/&rsquo;|&#8217;|&#x2019;/gi, '’')
    .replaceAll(/&apos;|&#39;|&#x27;/gi, "'");
const filesSaying = (pattern) =>
  sourceFiles(src)
    .filter((file) => pattern.test(decode(readFileSync(file, 'utf8'))))
    .map((file) => relative(src, file).split(sep).join('/'))
    .sort();

const NOT_PAID = /haven[’']t paid anything/i;

test('“You haven’t paid anything” appears only on the tip form and in the connection copy', () => {
  const allowed = new Set([
    'components/appreciation-form.tsx',
    'lib/connection-copy.ts',
    'app/design-system/states-specimen.tsx',
  ]);
  const files = filesSaying(NOT_PAID);
  assert.ok(files.includes('components/appreciation-form.tsx'), files.join());
  assert.deepEqual(
    files.filter((file) => !allowed.has(file)),
    [],
  );
});

test('on the tip form the safe line is tied to a tip that never reached TipMe', () => {
  const form = readFileSync(
    join(src, 'components/appreciation-form.tsx'),
    'utf8',
  );
  assert.match(
    form,
    /safe=\{reachedUs \? undefined : 'You haven’t paid anything\.'\}/,
  );
  assert.match(form, /setReachedUs\(result\.code !== 'NETWORK'\)/);
});
