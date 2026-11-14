#!/usr/bin/env node
// Splits the e2e burn-in (each changed spec file five times, no retries) over parallel CI jobs
// (14 Nov 2026). In one job a big merge train hit the 40-minute limit: PR #215 changed 41 spec
// files, 1,720 tests, and was cancelled after 944. Files, not Playwright's --shard, are split:
// a --shard run skips the @alone stage (scripts/run-e2e.mjs), and the burn-in must run those too.
//
//   node scripts/ci-burn-in.mjs plan            prints count=N and shards=[1..N] for GITHUB_OUTPUT
//   node scripts/ci-burn-in.mjs files <i> <N>   prints shard i's files, one per line
//
// Both read the space-separated changed spec files from SPECS.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** As many shards as the e2e suite has, so a burn-in never needs more runners than it does. */
export const MAX_SHARDS = 6;
/** Files per shard before another is added: 8 files × 5 runs fit well inside one job's limit. */
export const FILES_PER_SHARD = 8;

/** The fewest shards for `n` changed spec files: 0 for none, then one per 8 files, at most 6. */
export function shardCount(n) {
  return Math.min(MAX_SHARDS, Math.ceil(n / FILES_PER_SHARD));
}

/** Shard `index` (1-based) of `count`: every count-th file, so shares differ by at most one. */
export function shardFiles(files, index, count) {
  return files.filter((_, i) => i % count === index - 1);
}

function specs() {
  return (process.env.SPECS ?? '').split(/\s+/).filter(Boolean);
}

function main([command, index, count]) {
  if (command === 'plan') {
    const n = shardCount(specs().length);
    const lines = `count=${n}\nshards=${JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))}\n`;
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, lines);
    else process.stdout.write(lines);
    return 0;
  }
  if (
    command === 'files' &&
    Number(index) >= 1 &&
    Number(index) <= Number(count)
  ) {
    const share = shardFiles(specs(), Number(index), Number(count));
    process.stdout.write(share.map((file) => `${file}\n`).join(''));
    return 0;
  }
  console.error(
    'usage: ci-burn-in.mjs plan | files <index> <count>  (SPECS in the environment)',
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
