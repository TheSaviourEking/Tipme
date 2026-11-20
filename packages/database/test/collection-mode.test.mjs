import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mayAssignCollect } from '../dist/index.js';

// Ruling P11: every new `collect` assignment goes through mayAssignCollect, so plan Task 11 can stop
// them in one place when TipMe's own money is below the critical line.

const src = new URL('../src/operations/', import.meta.url);
const read = (name) => readFile(new URL(name, src), 'utf8');

/** The body of `function <name>` up to the next top-level function. */
function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test('mayAssignCollect allows a new collect assignment until Task 11 gates it', async () => {
  assert.equal(await mayAssignCollect({}), true);
});

test('both paths that assign collect, the sign-up and the first quote, ask mayAssignCollect', async () => {
  const mode = await read('collection-mode.ts');
  assert.match(bodyOf(mode, 'decideCollectionMode'), /mayAssignCollect\(/);
  assert.match(bodyOf(mode, 'signUpCollectionMode'), /mayAssignCollect\(/);
  const profiles = await read('profiles.ts');
  assert.match(
    bodyOf(profiles, 'claimHandle'),
    /collectionMode: await signUpCollectionMode\(/,
  );
});

test('nothing else writes collect onto a profile', async () => {
  const writers = [];
  for (const name of await readdir(src)) {
    if (!name.endsWith('.ts') || name === 'collection-mode.ts') continue;
    const source = await read(name);
    if (
      /collectionMode:\s*'collect'|collection_mode\s*=\s*'collect'/.test(source)
    )
      writers.push(name);
  }
  assert.deepEqual(writers, []);
});
