import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateHeads, testedTree, TESTED_CONTEXT } from './ci-reuse.mjs';

// When a merge into dev or main can reuse a pull request's green run: only if a PR run that
// passed every job recorded exactly this file tree on one of the merged commits.

const TREE = 'a'.repeat(40);
const status = (state, description, context = TESTED_CONTEXT) => ({
  state,
  description,
  context,
});

test('the newest tested-tree status, success, for exactly this tree: reuse', () => {
  assert.equal(testedTree(TREE, [status('success', `tree ${TREE}`)]), true);
});

test('a different tree, another context, or a failure never counts', () => {
  assert.equal(
    testedTree(TREE, [status('success', `tree ${'b'.repeat(40)}`)]),
    false,
  );
  assert.equal(
    testedTree(TREE, [status('success', `tree ${TREE}`, 'ci/other')]),
    false,
  );
  assert.equal(testedTree(TREE, [status('failure', `tree ${TREE}`)]), false);
  assert.equal(testedTree(TREE, []), false);
});

test('only the newest status for the context counts (the API lists newest first)', () => {
  // A later run on the same commit failed: the earlier success no longer stands.
  assert.equal(
    testedTree(TREE, [
      status('failure', `tree ${TREE}`),
      status('success', `tree ${TREE}`),
    ]),
    false,
  );
  // Other contexts in between don't matter.
  assert.equal(
    testedTree(TREE, [
      status('success', 'x', 'vercel'),
      status('success', `tree ${TREE}`),
    ]),
    true,
  );
});

test('a malformed tree is never matched', () => {
  assert.equal(testedTree('', [status('success', 'tree ')]), false);
  assert.equal(
    testedTree('not-a-sha', [status('success', 'tree not-a-sha')]),
    false,
  );
});

test('candidate heads: the merged-in parents of a merge commit, plus PR heads for squash merges', () => {
  assert.deepEqual(
    candidateHeads({
      parents: ['base', 'prhead'],
      pullHeads: ['prhead', 'other'],
    }),
    ['prhead', 'other'],
  );
  // A squash or fast-forward commit has one parent: only the PR heads are candidates.
  assert.deepEqual(
    candidateHeads({ parents: ['base'], pullHeads: ['prhead'] }),
    ['prhead'],
  );
  assert.deepEqual(candidateHeads({ parents: ['base'], pullHeads: [] }), []);
});
