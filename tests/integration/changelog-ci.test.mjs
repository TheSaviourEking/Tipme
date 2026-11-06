import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { draftFromPullRequest } from '../../packages/contracts/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { CHANGELOG_SECRET, startStack } from './helpers.mjs';

// Changelog plan, Task 3.4: the CI scripts against the real API. changelog-send.mjs drafts a PR
// whose merge commit lives in a repo built here; changelog-sync.mjs then finds that commit in a
// later version and marks the entry live.
const SEND = fileURLToPath(
  new URL('../../scripts/changelog-send.mjs', import.meta.url),
);
const SYNC = fileURLToPath(
  new URL('../../scripts/changelog-sync.mjs', import.meta.url),
);
const TEMPLATE = fileURLToPath(
  new URL('../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), 'changelog-ci-'));
const repo = join(scratch, 'repo');
let stack;
let database;
const shas = {};

const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

function commit(name) {
  writeFileSync(join(repo, `${name}.txt`), name);
  git('add', '.');
  git('commit', '-q', '-m', name);
  return git('rev-parse', 'HEAD');
}

function run(script, args, env) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          CHANGELOG_API_URL: stack.api,
          CHANGELOG_SIGNING_SECRET: CHANGELOG_SECRET,
          ...env,
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

const send = (number, values = {}) =>
  run(SEND, [], {
    PR_NUMBER: String(number),
    PR_TITLE: `feat: change ${number}`,
    PR_BODY: `Does thing ${number}.\n\n## For users\nYou can now do thing ${number}.`,
    PR_MERGE_SHA: shas.merged,
    PR_MERGED_AT: '2026-11-05T10:00:00Z',
    ...values,
  });

const row = async (number) =>
  (
    await database.pool.query(
      'SELECT staff_text, user_text, audience, staging_at, live_at, live_version FROM changelog_entries WHERE pr_number = $1',
      [number],
    )
  ).rows[0];

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({ databaseUrl: database.url });
  execFileSync('git', ['init', '-q', '-b', 'dev', repo]);
  commit('root');
  shas.merged = commit('the-change');
  shas.later = commit('later');
});
after(async () => {
  await stack?.stop();
  await database?.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('a merged PR sent by the CI script becomes a draft, once', async () => {
  const first = await send(700);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /#700 drafted/);
  assert.deepEqual(await row(700), {
    staff_text: 'feat: change 700 — Does thing 700.',
    user_text: 'You can now do thing 700.',
    audience: 'everyone',
    staging_at: null,
    live_at: null,
    live_version: null,
  });
  const again = await send(700, { PR_TITLE: 'feat: renamed' });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already drafted/);
  assert.equal(
    (await row(700)).staff_text,
    'feat: change 700 — Does thing 700.',
  );
});

test('the sync marks the draft on staging, then live, at a version containing its merge', async () => {
  const version = shas.later.slice(0, 12);
  const staging = await run(SYNC, [
    '--environment',
    'staging',
    '--version',
    version,
  ]);
  assert.equal(staging.code, 0, staging.out);
  assert.match(staging.out, /now on staging \(#700\)/);
  let entry = await row(700);
  assert.ok(entry.staging_at);
  assert.equal(entry.live_at, null);

  // A version from before the merge carries nothing.
  const early = await run(SYNC, [
    '--environment',
    'production',
    '--version',
    git('rev-parse', 'HEAD~2').slice(0, 12),
  ]);
  assert.equal(early.code, 0, early.out);
  assert.match(early.out, /nothing new is live/);
  assert.equal((await row(700)).live_at, null);

  const live = await run(SYNC, [
    '--environment',
    'production',
    '--version',
    version,
  ]);
  assert.equal(live.code, 0, live.out);
  assert.match(live.out, /1 entry now live \(#700\)/);
  entry = await row(700);
  assert.ok(entry.live_at);
  assert.equal(entry.live_version, version);

  // Running it again finds nothing pending.
  const again = await run(SYNC, [
    '--environment',
    'production',
    '--version',
    version,
  ]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /nothing new is live/);
});

test('a long body of non-ASCII text is cut to fit and still accepted', async () => {
  // 65 536 characters at 3 bytes each: 192 KiB, over the API's 128 KiB, unless the client cuts it.
  // Through the event file, as the workflow sends it: Linux refuses a variable this long.
  const event = join(repo, 'event-701.json');
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: {
        number: 701,
        title: 'feat: change 701',
        body: `Naira.\n\n## For users\nYou can now see ₦ amounts.\n\n## Notes\n${'₦'.repeat(65_500)}`,
        merge_commit_sha: shas.merged,
        merged_at: '2026-11-05T10:00:00Z',
      },
    }),
  );
  const result = await run(SEND, [], { CHANGELOG_EVENT_FILE: event });
  assert.equal(result.code, 0, result.out);
  assert.equal((await row(701)).user_text, 'You can now see ₦ amounts.');
});

test('a PR written from the empty template is staff only', async () => {
  const body = readFileSync(TEMPLATE, 'utf8');
  assert.equal(
    draftFromPullRequest({ title: 'chore: x', body }).audience,
    'staff',
  );
  const result = await send(702, { PR_BODY: body });
  assert.equal(result.code, 0, result.out);
  const entry = await row(702);
  assert.equal(entry.user_text, null);
  assert.equal(entry.audience, 'staff');
});

test('a wrong secret is refused and stores nothing', async () => {
  const result = await send(703, {
    CHANGELOG_SIGNING_SECRET: 'another-changelog-secret-of-32-characters',
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /signature refused/);
  assert.ok(!result.out.includes('another-changelog-secret'));
  assert.equal(await row(703), undefined);
});
