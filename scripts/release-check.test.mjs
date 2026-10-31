import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);

/**
 * A staging copy on the Bachs sandbox that answers /health/release and the public profile of
 * `pages` (handle → acceptingTips). Records the profile paths asked for.
 */
async function bachsCopy(pages, t) {
  const asked = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health/release')
      return response.end(
        JSON.stringify({
          data: {
            kind: 'test',
            version: 'abc1234',
            deploymentMode: 'production',
            paymentsLive: false,
            analytics: true,
            paymentProvider: 'bachs-sandbox',
          },
        }),
      );
    const handle = /^\/v1\/profiles\/([^/?]+)$/.exec(request.url ?? '')?.[1];
    if (handle) asked.push(handle);
    if (!handle || !(handle in pages)) {
      response.statusCode = 404;
      return response.end('{}');
    }
    response.end(
      JSON.stringify({
        data: { handle, displayName: 'Test', acceptingTips: pages[handle] },
      }),
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}`, asked };
}

const fullCheck = (api, env = {}) =>
  run(
    process.execPath,
    ['scripts/release-check.mjs', '--web', api, '--api', api, '--full'],
    {
      env: {
        PATH: process.env.PATH,
        RELEASE_CHECK_TOKEN: 't',
        RELEASE_OPS_EMAIL: 'release@example.com',
        RELEASE_OPS_TOTP_SECRET: 's',
        ...env,
      },
    },
  ).then(
    () => ({ code: 0, stderr: '' }),
    (error) => ({ code: error.code, stderr: error.stderr }),
  );

test('on Bachs, a missing standing test page stops the check at once and says how to make it', async (t) => {
  const copy = await bachsCopy({}, t);
  const { code, stderr } = await fullCheck(copy.api);
  assert.equal(code, 2);
  assert.match(stderr, /@release_bachs/);
  assert.match(stderr, /staging-setup\.md/);
  assert.deepEqual(copy.asked, ['release_bachs']);
});

test('on Bachs, a standing page that cannot take tips yet stops the check too', async (t) => {
  const copy = await bachsCopy({ release_bachs: false }, t);
  const { code, stderr } = await fullCheck(copy.api);
  assert.equal(code, 2);
  assert.match(stderr, /can’t take tips yet/);
});

test('RELEASE_BACHS_HANDLE names a different standing page', async (t) => {
  const copy = await bachsCopy({}, t);
  await fullCheck(copy.api, { RELEASE_BACHS_HANDLE: 'other_page' });
  assert.deepEqual(copy.asked, ['other_page']);
});

/**
 * A copy that answers /health/release as given and records what else it was asked, plus a stand-in
 * `pnpm` that records the environment the browser suite would have started with.
 */
async function liveCopy(info, t, { webhookStatus = 401 } = {}) {
  const posts = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health/release')
      return response.end(
        JSON.stringify({
          data: {
            kind: 'production',
            version: 'abc1234',
            deploymentMode: 'production',
            paymentsLive: true,
            analytics: true,
            paymentProvider: 'bachs-live',
            ...info,
          },
        }),
      );
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        posts.push({
          url: request.url,
          body,
          signed: Object.keys(request.headers).some((name) =>
            name.includes('signature'),
          ),
        });
        response.statusCode = webhookStatus;
        response.end('{}');
      });
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'tipme-rc-'));
  const record = join(dir, 'suite.json');
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/usr/bin/env bash\necho "{\\"full\\":\\"$RELEASE_FULL\\",\\"provider\\":\\"$RELEASE_PAYMENT_PROVIDER\\"}" > "${record}"\n`,
  );
  chmodSync(join(dir, 'pnpm'), 0o755);
  return {
    api: `http://127.0.0.1:${server.address().port}`,
    posts,
    suite: () =>
      existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null,
    path: `${dir}:${process.env.PATH}`,
  };
}

const check = (copy, args = []) =>
  run(
    process.execPath,
    [
      'scripts/release-check.mjs',
      '--web',
      copy.api,
      '--api',
      copy.api,
      ...args,
    ],
    { env: { PATH: copy.path } },
  ).then(
    (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
    (error) => ({
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    }),
  );

test('a live copy runs the read-only check', async (t) => {
  const copy = await liveCopy({}, t);
  const result = await check(copy, ['--expect-provider', 'bachs-live']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(copy.suite()?.full, '0');
  assert.equal(copy.suite()?.provider, 'bachs-live');
});

test('a live copy refuses --full', async (t) => {
  const copy = await liveCopy({}, t);
  const result = await check(copy, ['--full']);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /--full refused: this copy takes real payments\./,
  );
  assert.equal(copy.suite(), null);
});

test('an unexpected provider fails the check before the suite starts', async (t) => {
  const copy = await liveCopy({ paymentProvider: 'bachs-sandbox' }, t);
  const result = await check(copy, ['--expect-provider', 'bachs-live']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bachs-live/);
  assert.match(result.stderr, /bachs-sandbox/);
  assert.equal(copy.suite(), null);
});

test('the read-only check posts an unsigned empty body to the Bachs webhook and wants 401', async (t) => {
  const copy = await liveCopy({}, t);
  assert.equal((await check(copy)).code, 0);
  assert.deepEqual(copy.posts, [
    { url: '/v1/webhooks/bachs', body: '{}', signed: false },
  ]);
});

test('a Bachs webhook that accepts an unsigned call fails the check', async (t) => {
  const copy = await liveCopy({}, t, { webhookStatus: 200 });
  const result = await check(copy);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /webhook/i);
  assert.equal(copy.suite(), null);
});

test('a mock copy is not asked about the Bachs webhook', async (t) => {
  const copy = await liveCopy(
    { paymentsLive: false, kind: 'test', paymentProvider: 'mock' },
    t,
  );
  assert.equal((await check(copy)).code, 0);
  assert.deepEqual(copy.posts, []);
});
