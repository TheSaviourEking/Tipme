import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sign } from './changelog-client.mjs';

// Changelog plan, Task 3.1: scripts/changelog-send.mjs, run as CI runs it (a child process with env),
// against a fake TipMe on 127.0.0.1.
const SCRIPT = fileURLToPath(new URL('./changelog-send.mjs', import.meta.url));
const SECRET = 'send-test-secret-of-at-least-32-characters';
const SHA = 'c'.repeat(40);

let server;
let base;
let answers = [];
const received = [];
const scratch = mkdtempSync(join(tmpdir(), 'changelog-send-'));

before(async () => {
  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      received.push({ path: request.url, headers: request.headers, raw });
      const next = answers.shift() ?? {
        status: 200,
        body: { data: { created: true } },
      };
      response.writeHead(next.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(next.body));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

const reset = (...next) => {
  answers = next;
  received.length = 0;
};

function run(env) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        // Only what the step passes: nothing from this shell leaks in.
        env: { PATH: process.env.PATH, ...env },
        timeout: 20_000,
      },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const prEnv = (values = {}) => ({
  CHANGELOG_API_URL: base,
  CHANGELOG_SIGNING_SECRET: SECRET,
  PR_NUMBER: '41',
  PR_TITLE: 'feat: pin a note',
  PR_BODY: 'Why.\n\n## For users\nYou can pin a supporter note.',
  PR_MERGE_SHA: SHA,
  PR_MERGED_AT: '2026-11-05T10:00:00Z',
  ...values,
});

test('a merged PR is sent as a signed draft', async () => {
  reset();
  const result = await run(prEnv());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.length, 1);
  const [request] = received;
  assert.equal(request.path, '/v1/webhooks/changelog/drafts');
  assert.equal(
    request.headers['x-tipme-signature'],
    sign(
      SECRET,
      request.raw,
      Number(request.headers['x-tipme-timestamp']) * 1000,
    ).signature,
  );
  assert.deepEqual(JSON.parse(request.raw.toString('utf8')), {
    number: 41,
    title: 'feat: pin a note',
    body: 'Why.\n\n## For users\nYou can pin a supporter note.',
    mergeCommitSha: SHA,
    mergedAt: '2026-11-05T10:00:00Z',
  });
  assert.match(result.stdout, /#41/);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
});

test('a title with $(rm -rf /) and backticks is sent verbatim as JSON', async () => {
  reset();
  const title = 'fix: $(rm -rf /) `whoami` ${{ secrets.X }} "quoted"';
  const body = '`echo hi` $(id)\n\n## For users\n';
  const result = await run(prEnv({ PR_TITLE: title, PR_BODY: body }));
  assert.equal(result.code, 0, result.stderr);
  const sent = JSON.parse(received[0].raw.toString('utf8'));
  assert.equal(sent.title, title);
  assert.equal(sent.body, body);
});

test('an empty body is sent as null', async () => {
  reset();
  const result = await run(prEnv({ PR_BODY: '' }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(received[0].raw.toString('utf8')).body, null);
});

test('a draft TipMe already has is a success', async () => {
  reset({ status: 200, body: { data: { created: false } } });
  const result = await run(prEnv());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /already/i);
});

test('a 401 exits 1 with "signature refused"', async () => {
  reset({
    status: 401,
    body: { error: { code: 'CHANGELOG_SIGNATURE_INVALID' } },
  });
  const result = await run(prEnv());
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /signature refused/);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
});

test('a missing secret exits 0 with a notice, and sends nothing', async () => {
  reset();
  for (const env of [
    prEnv({ CHANGELOG_SIGNING_SECRET: '' }),
    (() => {
      const env = prEnv();
      delete env.CHANGELOG_SIGNING_SECRET;
      return env;
    })(),
    prEnv({ CHANGELOG_API_URL: '' }),
  ]) {
    const result = await run(env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /::notice::Changelog not set up/);
  }
  assert.equal(received.length, 0);
});

test('a 5xx is retried once', async () => {
  reset(
    { status: 503, body: {} },
    { status: 200, body: { data: { created: true } } },
  );
  const result = await run(prEnv());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.length, 2);
});

test('a bad number, sha or date exits 1 before sending', async () => {
  reset();
  for (const values of [
    { PR_NUMBER: 'abc' },
    { PR_NUMBER: '0' },
    { PR_MERGE_SHA: 'c'.repeat(39) },
    { PR_MERGED_AT: '' },
    { PR_TITLE: '' },
  ]) {
    const result = await run(prEnv(values));
    assert.equal(result.code, 1, JSON.stringify(values));
    assert.match(result.stdout + result.stderr, /::error::/);
  }
  assert.equal(received.length, 0);
});

test('a resend reads the PR from a gh pr view file, and only a PR merged into dev', async () => {
  const file = join(scratch, 'pr.json');
  const pr = {
    number: 52,
    title: 'feat: resend me',
    body: 'Body.',
    mergeCommit: { oid: SHA },
    mergedAt: '2026-11-04T09:00:00Z',
    baseRefName: 'dev',
    state: 'MERGED',
  };
  const env = {
    CHANGELOG_API_URL: base,
    CHANGELOG_SIGNING_SECRET: SECRET,
    CHANGELOG_PR_FILE: file,
  };
  writeFileSync(file, JSON.stringify(pr));
  reset();
  const sent = await run(env);
  assert.equal(sent.code, 0, sent.stderr);
  assert.deepEqual(JSON.parse(received[0].raw.toString('utf8')), {
    number: 52,
    title: 'feat: resend me',
    body: 'Body.',
    mergeCommitSha: SHA,
    mergedAt: '2026-11-04T09:00:00Z',
  });

  for (const other of [
    { state: 'OPEN', mergeCommit: null, mergedAt: null },
    { baseRefName: 'main' },
  ]) {
    writeFileSync(file, JSON.stringify({ ...pr, ...other }));
    reset();
    const refused = await run(env);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout + refused.stderr, /::error::/);
    assert.equal(received.length, 0);
  }
});
