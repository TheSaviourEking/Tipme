#!/usr/bin/env node
// Merges a pull request only when every CI check has passed (`pnpm pr:merge <number>`).
// This repository's GitHub plan has no branch protection, so nothing else stops a red PR
// from being merged into dev and deployed to staging.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Checks that count as green. Anything else (fail, pending, cancel) refuses the merge. */
const GREEN = new Set(['pass', 'skipping']);

/** Whether a PR may be merged, with the reasons it may not. */
export function mergeDecision({ pr, checks }) {
  const reasons = [];
  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state}, not open`);
  if (pr.isDraft) reasons.push('the PR is a draft');
  if (pr.mergeable === 'CONFLICTING')
    reasons.push('the PR has merge conflicts');
  if (checks.length === 0) reasons.push('no CI checks have reported yet');
  for (const check of checks)
    if (!GREEN.has(check.bucket))
      reasons.push(`${check.name}: ${check.bucket}`);
  return { ok: reasons.length === 0, reasons };
}

async function defaultGh(args) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    // `gh pr checks` exits non-zero while checks fail or are pending; its JSON is still valid.
    if (typeof error.stdout === 'string' && error.stdout.trim())
      return error.stdout;
    throw error;
  }
}

export async function main(
  argv = process.argv.slice(2),
  { gh = defaultGh, log = (line) => console.log(line) } = {},
) {
  const number = argv[0];
  if (!/^\d+$/.test(number ?? '')) {
    log('Usage: pnpm pr:merge <pull request number>');
    return 2;
  }
  const pr = JSON.parse(
    await gh(['pr', 'view', number, '--json', 'state,isDraft,mergeable']),
  );
  const checks = JSON.parse(
    await gh(['pr', 'checks', number, '--json', 'name,bucket']),
  );
  const decision = mergeDecision({ pr, checks });
  if (!decision.ok) {
    log(`Not merging #${number}:`);
    for (const reason of decision.reasons) log(`  - ${reason}`);
    return 1;
  }
  await gh(['pr', 'merge', number, '--merge']);
  log(`Merged #${number}: every check passed.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
