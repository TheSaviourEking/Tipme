import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STAGING_CONTEXT,
  checkCandidates,
  findStagingPass,
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

// The statuses endpoint is only trusted with full shas: every candidate is resolved first.
const FULL_MAIN = 'c'.repeat(40);
const FULL_STAGED = 'd'.repeat(40);
function stubApi(calls) {
  const answers = {
    [`repos/o/r/commits/${FULL_MAIN}`]: {
      sha: FULL_MAIN,
      commit: { tree: { sha: T } },
      parents: [],
    },
    [`repos/o/r/commits/${FULL_MAIN}/pulls`]: [],
    'repos/o/r/commits/dddddddddddd': { sha: FULL_STAGED },
    [`repos/o/r/commits/${FULL_STAGED}/statuses`]: [
      status('success', `tree ${T}`),
    ],
    [`repos/o/r/commits/${FULL_MAIN}/statuses`]: [],
  };
  return (path) => {
    calls.push(path);
    if (!(path in answers)) throw new Error(`unexpected ${path}`);
    return JSON.stringify(answers[path]);
  };
}

test('a short staging version is resolved to a full sha before its statuses are read', () => {
  const calls = [];
  const result = findStagingPass({
    repo: 'o/r',
    sha: FULL_MAIN,
    stagingVersion: 'd'.repeat(12),
    api: stubApi(calls),
  });
  assert.deepEqual(result, { tree: T, head: FULL_STAGED });
  for (const c of calls.filter((c) => c.endsWith('/statuses')))
    assert.match(c, /commits\/[0-9a-f]{40}\/statuses$/);
});

test('no passing candidate returns no head', () => {
  const calls = [];
  const result = findStagingPass({
    repo: 'o/r',
    sha: FULL_MAIN,
    api: stubApi(calls),
  });
  assert.deepEqual(result, { tree: T, head: undefined });
});
