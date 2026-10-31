import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STAGING_CONTEXT,
  checkCandidates,
  stagingPassed,
} from './staging-pass.mjs';

// Production deploys only a main commit whose file tree staging's full release check passed.

const T = 'a'.repeat(40);
const status = (state, description, context = STAGING_CONTEXT) => ({
  state,
  description,
  context,
});

test('a success with the same tree passes', () =>
  assert.equal(stagingPassed(T, [status('success', `tree ${T}`)]), true));

test('a newer failure hides an older success', () =>
  assert.equal(
    stagingPassed(T, [
      status('failure', `tree ${T}`),
      status('success', `tree ${T}`),
    ]),
    false,
  ));

test('another tree, another context, or a malformed sha does not pass', () => {
  assert.equal(
    stagingPassed(T, [status('success', `tree ${'b'.repeat(40)}`)]),
    false,
  );
  assert.equal(
    stagingPassed(T, [status('success', `tree ${T}`, 'ci/tested-tree')]),
    false,
  );
  assert.equal(stagingPassed('abc', [status('success', 'tree abc')]), false);
  assert.equal(stagingPassed(T, []), false);
});

test('candidates are the commit, its parents, PR heads and the staging version', () => {
  assert.deepEqual(
    checkCandidates({
      sha: 'm',
      parents: ['p1', 'p2'],
      pullHeads: ['h', 'p2'],
      stagingVersion: 's',
    }),
    ['m', 'p1', 'p2', 'h', 's'],
  );
  assert.deepEqual(checkCandidates({ sha: 'm', parents: [], pullHeads: [] }), [
    'm',
  ]);
});
