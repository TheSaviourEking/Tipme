import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sign } from './changelog-client.mjs';

// Changelog plan, Task 3.2: scripts/changelog-sync.mjs marks entries live by git ancestry. The
// repo is built here; TipMe is a fake on 127.0.0.1.
const SCRIPT = fileURLToPath(new URL('./changelog-sync.mjs', import.meta.url));
const SECRET = 'sync-test-secret-of-at-least-32-characters';
const DAY = 24 * 60 * 60 * 1000;

const scratch = mkdtempSync(join(tmpdir(), 'changelog-sync-'));
const repo = join(scratch, 'repo');
let server;
let base;
let pending = [];
let failPending = null;
const received = [];
const shas = {};

function git(args, { date } = {}) {
  const when = date ? new Date(date).toISOString() : undefined;
  return execFileSync('git', args, {
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
      ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}),
    },
  }).trim();
}
const head = () => git(['rev-parse', 'HEAD']);
const commit = (name, options) => {
  writeFileSync(join(repo, `${name}.txt`), name);
  git(['add', '.']);
  git(['commit', '-q', '-m', name], options);
  return head();
};
const mergeInto = (branch, from, message) => {
  git(['checkout', '-q', branch]);
  git(['merge', '-q', '--no-ff', '-m', message, from]);
  return head();
};

before(async () => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  commit('root');
  git(['checkout', '-q', '-b', 'dev']);
  // PR A: a merge commit into dev.
  git(['checkout', '-q', '-b', 'feature-a', 'dev']);
  commit('a');
  shas.a = mergeInto(
    'dev',
    'feature-a',
    'Merge pull request #1 from feature-a',
  );
  // PR S: squash-merged, so its "merge commit" is a plain commit on dev.
  shas.s = commit('s');
  // main takes dev, by a merge commit.
  shas.main1 = mergeInto('main', 'dev', 'Merge pull request #10 from dev');
  // PR B: merged into dev after that.
  git(['checkout', '-q', '-b', 'feature-b', 'dev']);
  commit('b');
  shas.b = mergeInto(
    'dev',
    'feature-b',
    'Merge pull request #2 from feature-b',
  );
  // PR O: merged 20 days ago, but on a branch main never took (as if dev were squashed into main).
  git(['checkout', '-q', '-b', 'stray', shas.a]);
  shas.o = commit('o', { date: Date.now() - 20 * DAY });
  git(['checkout', '-q', 'main']);

  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString('utf8'));
      received.push({ path: request.url, headers: request.headers, raw, body });
      const route = request.url.split('/').pop();
      const answer = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (route === 'pending') {
        if (failPending) return answer(failPending, {});
        return answer(200, { data: pending });
      }
      if (route === 'releases')
        return answer(200, { data: { marked: body.contained } });
      answer(404, {});
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function reset(entries) {
  pending = entries;
  failPending = null;
  received.length = 0;
}

function sync(args, env = {}) {
  const summary = join(
    scratch,
    `summary-${Math.random().toString(16).slice(2)}.md`,
  );
  writeFileSync(summary, '');
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          CHANGELOG_API_URL: base,
          CHANGELOG_SIGNING_SECRET: SECRET,
          GITHUB_STEP_SUMMARY: summary,
          ...env,
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? 1) : 0,
          stdout,
          stderr,
          summary: readFileSync(summary, 'utf8'),
        }),
    );
  });
}

const version = (sha) => sha.slice(0, 12);
const releases = () => received.filter((r) => r.path.endsWith('/releases'));
const all = () => [
  { number: 1, mergeSha: shas.a },
  { number: 2, mergeSha: shas.b },
  { number: 3, mergeSha: shas.s },
];

test('a sync at main marks the merges main contains, and not the later one', async () => {
  reset(all());
  const result = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(
    received.map((r) => r.path),
    ['/v1/webhooks/changelog/pending', '/v1/webhooks/changelog/releases'],
  );
  assert.deepEqual(received[0].body, { environment: 'production' });
  // The squash-merged PR S is contained too: its commit is on dev, which main merged.
  assert.deepEqual(releases()[0].body, {
    environment: 'production',
    version: version(shas.main1),
    contained: [1, 3],
  });
  for (const request of received) {
    assert.equal(
      request.headers['x-tipme-signature'],
      sign(
        SECRET,
        request.raw,
        Number(request.headers['x-tipme-timestamp']) * 1000,
      ).signature,
    );
  }
  assert.match(result.summary, /Changelog: 2 entries now live \(#1, #3\)/);
  // B is recent: not contained yet, and no warning.
  assert.doesNotMatch(result.summary, /14 days/);
  assert.ok(!(result.stdout + result.stderr + result.summary).includes(SECRET));
});

test('after main merges dev again, a sync marks B', async () => {
  const main2 = mergeInto('main', 'dev', 'Merge pull request #11 from dev');
  try {
    reset([{ number: 2, mergeSha: shas.b }]);
    const result = await sync([
      '--environment',
      'production',
      '--version',
      version(main2),
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(releases()[0].body.contained, [2]);
    assert.match(result.summary, /Changelog: 1 entry now live \(#2\)/);
  } finally {
    git(['reset', '-q', '--hard', shas.main1]);
  }
});

test('staging marks with environment staging and says "on staging"', async () => {
  reset(all());
  const result = await sync([
    '--environment',
    'staging',
    '--version',
    version(shas.b),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(received[0].body, { environment: 'staging' });
  assert.deepEqual(releases()[0].body, {
    environment: 'staging',
    version: version(shas.b),
    contained: [1, 2, 3],
  });
  assert.match(
    result.summary,
    /Changelog: 3 entries now on staging \(#1, #2, #3\)/,
  );
});

test('an unknown sha is listed in the summary and skipped', async () => {
  reset([...all(), { number: 4, mergeSha: 'f'.repeat(40) }]);
  const result = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(releases()[0].body.contained, [1, 3]);
  assert.match(result.summary, /#4/);
  assert.match(result.summary, /not in this checkout/i);
});

test('an entry older than 14 days and not contained is listed, by its commit date', async () => {
  reset([...all(), { number: 5, mergeSha: shas.o }]);
  const result = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(releases()[0].body.contained, [1, 3]);
  assert.match(
    result.summary,
    /not in this version after 14 days: check that main still merges dev with a merge commit/,
  );
  assert.match(result.summary, /#5/);
  assert.doesNotMatch(result.summary, /#2\b.*14 days|14 days[^\n]*#2\b/);
  assert.match(result.stdout, /::warning::/);
});

test('nothing contained: no releases call', async () => {
  reset([{ number: 2, mergeSha: shas.b }]);
  const result = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(releases().length, 0);
  assert.match(
    result.summary,
    /Changelog: nothing new is live in this version/,
  );

  reset([]);
  const empty = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(empty.code, 0);
  assert.equal(releases().length, 0);
});

test('a missing secret exits 0 with a notice and calls nothing', async () => {
  reset(all());
  const result = await sync(
    ['--environment', 'production', '--version', version(shas.main1)],
    { CHANGELOG_SIGNING_SECRET: '' },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /::notice::Changelog not set up/);
  assert.equal(received.length, 0);
});

test('--api overrides CHANGELOG_API_URL', async () => {
  reset(all());
  const result = await sync(
    [
      '--environment',
      'production',
      '--version',
      version(shas.main1),
      '--api',
      base,
    ],
    { CHANGELOG_API_URL: '' },
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(releases().length, 1);
});

test('bad arguments, a version not in the checkout or a refused call exit 1', async () => {
  reset(all());
  for (const args of [
    ['--environment', 'preview', '--version', version(shas.main1)],
    ['--environment', 'production', '--version', 'abc'],
    ['--environment', 'production'],
    ['--environment', 'production', '--version', '0123456789ab'],
  ]) {
    const result = await sync(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stdout + result.stderr, /::error::/);
  }
  assert.equal(received.length, 0);

  reset(all());
  failPending = 401;
  const refused = await sync([
    '--environment',
    'production',
    '--version',
    version(shas.main1),
  ]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /signature refused/);
  assert.equal(releases().length, 0);
});
