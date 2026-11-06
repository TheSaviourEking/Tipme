#!/usr/bin/env node
// Sends one merged pull request to TipMe as a changelog draft (changelog plan, Task 3.1). Run by
// .github/workflows/changelog-draft.yml, which passes everything through env, never through
// `${{ }}` in a shell line: the title and body are untrusted text.
//
//   PR_NUMBER, PR_TITLE, PR_BODY, PR_MERGE_SHA, PR_MERGED_AT   the merged PR (the merge event), or
//   CHANGELOG_PR_FILE                                           `gh pr view --json number,title,body,mergeCommit,mergedAt,baseRefName,state` output (a resend)
//   CHANGELOG_API_URL, CHANGELOG_SIGNING_SECRET                 where to send it, and the key
//
// Exits 0 with a notice when the changelog is not set up yet, 1 on any failure.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { draftPayload, post, settingsFrom } from './changelog-client.mjs';

const SHA = /^[0-9a-f]{40}$/;

/** The PR to send, from the resend file or the event's env. Throws a message on bad input. */
function pullRequestFrom(env) {
  if (env.CHANGELOG_PR_FILE) {
    const pr = JSON.parse(readFileSync(env.CHANGELOG_PR_FILE, 'utf8'));
    if (pr.state !== 'MERGED' || !pr.mergeCommit?.oid)
      throw new Error(`#${pr.number} is not merged.`);
    if (pr.baseRefName !== 'dev')
      throw new Error(
        `#${pr.number} was merged into ${pr.baseRefName}, not dev: only PRs into dev are drafted.`,
      );
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      mergeCommitSha: pr.mergeCommit.oid,
      mergedAt: pr.mergedAt,
    };
  }
  return {
    number: /^[0-9]+$/.test(env.PR_NUMBER ?? '') ? Number(env.PR_NUMBER) : NaN,
    title: env.PR_TITLE,
    body: env.PR_BODY,
    mergeCommitSha: env.PR_MERGE_SHA,
    mergedAt: env.PR_MERGED_AT,
  };
}

function checked(pr) {
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0)
    throw new Error('PR_NUMBER is not a pull request number.');
  if (!pr.title) throw new Error(`#${pr.number} has no title.`);
  if (!SHA.test(pr.mergeCommitSha ?? ''))
    throw new Error(
      `#${pr.number}: the merge commit is not a 40-character sha.`,
    );
  if (!pr.mergedAt || Number.isNaN(Date.parse(pr.mergedAt)))
    throw new Error(`#${pr.number}: the merge date is missing or not a date.`);
  return pr;
}

export async function main(env = process.env) {
  const settings = settingsFrom(env);
  if (!settings.secret) {
    console.log(
      `::notice::Changelog not set up: ${settings.missing} is not set, so no draft was sent (docs/runbooks/changelog.md).`,
    );
    return 0;
  }
  let pr;
  try {
    pr = checked(pullRequestFrom(env));
  } catch (error) {
    console.log(`::error::Changelog draft not sent: ${error.message}`);
    return 1;
  }
  try {
    const answer = await post(
      settings.api,
      'drafts',
      draftPayload(pr),
      settings.secret,
    );
    console.log(
      answer?.data?.created
        ? `Changelog: #${pr.number} drafted.`
        : `Changelog: #${pr.number} was already drafted; nothing changed.`,
    );
    return 0;
  } catch (error) {
    console.log(
      `::error::Changelog draft for #${pr.number} failed: ${error.message}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
