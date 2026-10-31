#!/usr/bin/env node
// Lets a push to dev or main reuse a pull request's green run (31 Oct 2026). A PR run that passed
// every job records the file tree it tested as a commit status on the PR's head commit. A merge
// whose commit has that exact tree has already been tested, so the push run skips its jobs (and
// still concludes success, which is what starts the staging deploy). Anything else runs in full.
//
//   node scripts/ci-reuse.mjs decide   (push to dev/main: prints reused=true|false for GITHUB_OUTPUT)
//   node scripts/ci-reuse.mjs record   (a green PR run: records the tested tree on the PR head)
//
// Uses `gh api` with GH_TOKEN, and GITHUB_REPOSITORY / GITHUB_SHA from Actions.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TESTED_CONTEXT = 'ci/tested-tree';
const SHA = /^[0-9a-f]{40}$/;

/** Whether the newest `ci/tested-tree` status (statuses are newest first) is a success for `tree`. */
export function testedTree(tree, statuses) {
  if (!SHA.test(tree)) return false;
  const newest = statuses.find((s) => s.context === TESTED_CONTEXT);
  return newest?.state === 'success' && newest.description === `tree ${tree}`;
}

/** Commits that may carry a PR's record: a merge commit's merged-in parents, and PR heads. */
export function candidateHeads({ parents, pullHeads }) {
  return [...new Set([...parents.slice(1), ...pullHeads])];
}

export function gh(path, query) {
  const out = execFileSync(
    'gh',
    ['api', path, ...(query ? ['-q', query] : [])],
    {
      encoding: 'utf8',
    },
  );
  return out.trim();
}

function decide() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const commit = JSON.parse(gh(`repos/${repo}/commits/${sha}`));
  const tree = commit.commit.tree.sha;
  const parents = commit.parents.map((p) => p.sha);
  const pullHeads = JSON.parse(gh(`repos/${repo}/commits/${sha}/pulls`)).map(
    (p) => p.head.sha,
  );
  let reused = false;
  for (const head of candidateHeads({ parents, pullHeads })) {
    const statuses = JSON.parse(gh(`repos/${repo}/commits/${head}/statuses`));
    if (testedTree(tree, statuses)) {
      console.log(
        `Tree ${tree} passed every job on ${head}: reusing that run.`,
      );
      reused = true;
      break;
    }
  }
  if (!reused)
    console.log(
      `Tree ${tree} has no green pull request run: running everything.`,
    );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
}

function record() {
  const repo = process.env.GITHUB_REPOSITORY;
  const head = process.env.PR_HEAD_SHA;
  // GITHUB_SHA on a pull_request run is the merge commit it tested.
  const tree = JSON.parse(gh(`repos/${repo}/commits/${process.env.GITHUB_SHA}`))
    .commit.tree.sha;
  execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/statuses/${head}`,
      '-f',
      'state=success',
      '-f',
      `context=${TESTED_CONTEXT}`,
      '-f',
      `description=tree ${tree}`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`Recorded tree ${tree} as tested on ${head}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'decide') decide();
  else if (command === 'record') record();
  else {
    console.error('usage: node scripts/ci-reuse.mjs decide|record');
    process.exit(2);
  }
}
