#!/usr/bin/env node
// Records that staging's full release check passed for a file tree, and lets the production
// deploy refuse a main commit whose tree has no such pass (31 Oct 2026). The pass is a commit
// status on the commit staging deployed (dev), so a main commit with the same tree (a merge of
// that dev work) finds it through itself, its parents, its PR heads or the staging version.
//
//   RECORD_SHA=<40-hex> node scripts/staging-pass.mjs record
//   node scripts/staging-pass.mjs check <sha> [--staging-version <sha>]
//
// Uses `gh api` with GH_TOKEN, and GITHUB_REPOSITORY from Actions.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gh } from './ci-reuse.mjs';

export const STAGING_CONTEXT = 'release/staging-full';
const SHA = /^[0-9a-f]{40}$/;
const REF = /^[0-9a-f]{7,40}$/;

/** Whether the newest `release/staging-full` status (newest first) is a success for `tree`. */
export function stagingPassed(tree, statuses) {
  if (!SHA.test(tree)) return false;
  const newest = statuses.find((s) => s.context === STAGING_CONTEXT);
  return newest?.state === 'success' && newest.description === `tree ${tree}`;
}

/** Commits that may carry the pass: the commit, every parent, its PR heads, staging's version. */
export function checkCandidates({ sha, parents, pullHeads, stagingVersion }) {
  return [
    ...new Set([sha, ...parents, ...pullHeads, stagingVersion].filter(Boolean)),
  ];
}

function record() {
  const repo = process.env.GITHUB_REPOSITORY;
  // Not GITHUB_SHA: the staging deploy is triggered from one ref but checks out another.
  const sha = process.env.RECORD_SHA;
  if (!SHA.test(sha ?? '')) {
    console.error('RECORD_SHA must be the full 40-character commit sha.');
    process.exit(2);
  }
  const tree = JSON.parse(gh(`repos/${repo}/commits/${sha}`)).commit.tree.sha;
  execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/statuses/${sha}`,
      '-f',
      'state=success',
      '-f',
      `context=${STAGING_CONTEXT}`,
      '-f',
      `description=tree ${tree}`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`Recorded full staging pass for tree ${tree} on ${sha}.`);
}

function check(args) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = args[0];
  const flag = args.indexOf('--staging-version');
  const stagingVersion = flag === -1 ? undefined : args[flag + 1];
  if (
    !REF.test(sha ?? '') ||
    (flag !== -1 && !REF.test(stagingVersion ?? ''))
  ) {
    console.error(
      'usage: node scripts/staging-pass.mjs check <sha> [--staging-version <sha>]',
    );
    process.exit(2);
  }
  const commit = JSON.parse(gh(`repos/${repo}/commits/${sha}`));
  const tree = commit.commit.tree.sha;
  const parents = commit.parents.map((p) => p.sha);
  const pullHeads = JSON.parse(gh(`repos/${repo}/commits/${sha}/pulls`)).map(
    (p) => p.head.sha,
  );
  for (const head of checkCandidates({
    sha,
    parents,
    pullHeads,
    stagingVersion,
  })) {
    const statuses = JSON.parse(gh(`repos/${repo}/commits/${head}/statuses`));
    if (stagingPassed(tree, statuses)) {
      console.log(`Tree ${tree} passed the full staging check on ${head}.`);
      return;
    }
  }
  console.error(`Tree ${tree} has no full staging pass.`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'record') record();
  else if (command === 'check') check(process.argv.slice(3));
  else {
    console.error(
      'usage: node scripts/staging-pass.mjs record | check <sha> [--staging-version <sha>]',
    );
    process.exit(2);
  }
}
