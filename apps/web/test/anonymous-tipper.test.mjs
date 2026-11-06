import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The owner, 6 Nov 2026: a tip from someone who gave no name reads "Anonymous", never "a guest".
// Every place that falls back from the supporter's name is checked: the web, mail and the database
// operations that write notifications and the export.
const ROOTS = [
  'src',
  '../../packages/mail/src',
  '../../packages/database/src/operations',
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('no fallback for a nameless tipper says "guest"', () => {
  const found = ROOTS.flatMap(files).filter((path) =>
    /\?\?\s*['"`][Aa] guest\b/.test(readFileSync(path, 'utf8')),
  );
  assert.deepEqual(found, []);
});
