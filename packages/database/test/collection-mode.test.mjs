import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mayAssignCollect } from '../dist/index.js';

// Ruling P11: every new `collect` assignment goes through mayAssignCollect, so plan Task 11 can stop
// them in one place when TipMe's own money is below the critical line. ESM exports can't be spied
// on, so these read the source.

const src = new URL('../src/', import.meta.url);

/** The body of `function <name>` up to the next top-level export. */
function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** Every .ts file under src, as [path relative to src, text]. */
async function sources() {
  const files = [];
  for (const entry of await readdir(src, { recursive: true })) {
    if (!entry.endsWith('.ts')) continue;
    files.push([entry, await readFile(new URL(entry, src), 'utf8')]);
  }
  return files;
}

/**
 * Ways a profile's mode can be written outside collection-mode.ts:
 * - any `.set({ … collectionMode … })`, whatever the value;
 * - raw SQL naming `collection_mode` (no operation needs it);
 * - a profiles insert whose `collectionMode` isn't the gated sign-up helper's.
 */
function modeWrites(source) {
  const found = [];
  for (const match of source.matchAll(/\.set\(\s*\{[^}]*\bcollectionMode\b/g))
    found.push(match[0]);
  for (const match of source.matchAll(/[^\n]*\bcollection_mode\b[^\n]*/g))
    found.push(match[0].trim());
  for (const match of source.matchAll(
    /\.insert\(profiles\)[\s\S]{0,800}?\bcollectionMode\b(?!:\s*await signUpCollectionMode\()/g,
  ))
    found.push(match[0].slice(0, 40));
  return found;
}

test('mayAssignCollect refuses a new collect assignment while sign-ups are paused (Task 11)', async () => {
  // The reserve check is injected; by default it reads the open collect_invariant_broken issue.
  assert.equal(
    await mayAssignCollect({}, { signupsPaused: async () => false }),
    true,
  );
  assert.equal(
    await mayAssignCollect({}, { signupsPaused: async () => true }),
    false,
  );
});

test('both paths that assign collect, the sign-up and the first quote, ask mayAssignCollect', async () => {
  const mode = await readFile(
    new URL('operations/collection-mode.ts', src),
    'utf8',
  );
  // The quote's decision and the screens' read-only preview share one set of rules (Task 14,
  // re-review 2 R2-I1), and those rules ask mayAssignCollect.
  assert.match(bodyOf(mode, 'decideCollectionMode'), /nextCollectionMode\(/);
  assert.match(bodyOf(mode, 'previewCollectionMode'), /nextCollectionMode\(/);
  assert.match(bodyOf(mode, 'nextCollectionMode'), /mayAssignCollect\(/);
  assert.match(bodyOf(mode, 'signUpCollectionMode'), /mayAssignCollect\(/);
  const profiles = await readFile(
    new URL('operations/profiles.ts', src),
    'utf8',
  );
  // Inside the sign-up's own transaction, so the check and the insert are one unit.
  const claim = bodyOf(profiles, 'claimHandle');
  assert.match(claim, /collectionMode: await signUpCollectionMode\(\s*runner,/);
  assert.match(
    claim,
    /input\.youCollectOn\s*\?\s*await db\.transaction\(async \(tx\) => insertPage\(tx\)\)/,
  );
});

test('the check finds every way of writing a mode', () => {
  assert.equal(
    modeWrites(`tx.update(profiles).set({ collectionMode: mode })`).length,
    1,
  );
  assert.equal(modeWrites(`.set({ status: 'x', collectionMode })`).length, 1);
  assert.equal(
    modeWrites('sql`UPDATE profiles SET collection_mode = ${m}`').length,
    1,
  );
  assert.equal(
    modeWrites(`db.insert(profiles).values({ id, collectionMode: picked })`)
      .length,
    1,
  );
  assert.deepEqual(
    modeWrites(
      `tx.insert(profiles).values({ id, collectionMode: await signUpCollectionMode(tx, on) })`,
    ),
    [],
  );
  // Reading it, or writing a quote's, is not writing a person's.
  assert.deepEqual(
    modeWrites(
      `select({ mode: profiles.collectionMode }); tx.insert(tipQuotes).values({ collectionMode })`,
    ),
    [],
  );
});

test('nothing outside collection-mode.ts writes a mode onto a profile', async () => {
  const writers = [];
  for (const [name, source] of await sources()) {
    if (name === 'operations/collection-mode.ts' || name === 'schema.ts')
      continue;
    if (modeWrites(source).length > 0) writers.push([name, modeWrites(source)]);
  }
  assert.deepEqual(writers, []);
});
