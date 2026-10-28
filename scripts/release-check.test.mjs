import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
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
        RELEASE_OPS_PHONE: '+2348000000000',
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
