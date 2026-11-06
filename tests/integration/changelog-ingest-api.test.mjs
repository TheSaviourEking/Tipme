import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { CHANGELOG_SECRET, startStack } from './helpers.mjs';

// Changelog plan, Task 2.3: the three signed routes CI calls. The signature is checked before the
// body is parsed; nothing is stored for a request that fails it; no secret means no routes.

const VERSION = '0123456789ab';
const sha = (n) => n.toString(16).padStart(40, 'b');
const MARKER = 'body-marker-api-5d2e';
let stack;
let off;
let database;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({ databaseUrl: database.url });
  off = await startStack({
    databaseUrl: database.url,
    apiEnv: { CHANGELOG_SIGNING_SECRET: '' },
  });
});
after(async () => {
  await stack?.stop();
  await off?.stop();
  await database?.close();
});

function signed(body, { secret = CHANGELOG_SECRET, at = Date.now() } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(at / 1000));
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-tipme-timestamp': timestamp,
      'x-tipme-signature': `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${raw}`)
        .digest('hex')}`,
    },
  };
}

async function post(api, path, body, options) {
  const { raw, headers } = signed(body, options);
  return fetch(`${api}/v1/webhooks/changelog/${path}`, {
    method: 'POST',
    headers: options?.headers ?? headers,
    body: raw,
  });
}

const draft = (number, values = {}) => ({
  number,
  title: `feat: change ${number}`,
  body: `Does thing ${number}.\n\n## Notes\n${MARKER}\n\n## For users\nYou can now do thing ${number}.`,
  mergeCommitSha: sha(number),
  mergedAt: '2026-11-05T10:00:00Z',
  ...values,
});

const entries = async () =>
  (
    await database.pool.query(
      'SELECT pr_number, live_at, live_version FROM changelog_entries ORDER BY pr_number',
    )
  ).rows;

test('a signed draft is stored and answered { created: true }; the same again { created: false }', async () => {
  const first = await post(stack.api, 'drafts', draft(300));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { data: { created: true } });
  const again = await post(stack.api, 'drafts', draft(300));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { data: { created: false } });
  const { rows } = await database.pool.query(
    'SELECT staff_text, user_text FROM changelog_entries WHERE pr_number = 300',
  );
  assert.deepEqual(rows, [
    {
      staff_text: 'feat: change 300 — Does thing 300.',
      user_text: 'You can now do thing 300.',
    },
  ]);
  // Request logs keep the route and status, never the body.
  const logged = JSON.stringify(stack.logs);
  assert.ok(!logged.includes(MARKER), 'the PR body reached a log');
  assert.ok(
    stack.logs.some(
      (line) =>
        line.event === 'http.request' &&
        line.route === '/v1/webhooks/changelog/drafts' &&
        line.status === 200,
    ),
  );
});

test('an unsigned, stale or wrongly signed request is 401 and stores nothing', async () => {
  const before = await entries();
  const body = draft(310);
  const { raw, headers } = signed(body);
  const attempts = {
    unsigned: { 'content-type': 'application/json' },
    'no timestamp': {
      'content-type': 'application/json',
      'x-tipme-signature': headers['x-tipme-signature'],
    },
    stale: signed(body, { at: Date.now() - 301_000 }).headers,
    ahead: signed(body, { at: Date.now() + 301_000 }).headers,
    'other secret': signed(body, {
      secret: 'another-changelog-secret-of-32-characters',
    }).headers,
    'body changed': headers,
  };
  for (const [name, attemptHeaders] of Object.entries(attempts)) {
    const response = await fetch(`${stack.api}/v1/webhooks/changelog/drafts`, {
      method: 'POST',
      headers: attemptHeaders,
      body: name === 'body changed' ? raw.replace('310', '311') : raw,
    });
    assert.equal(response.status, 401, name);
    assert.equal(
      (await response.json()).error.code,
      'CHANGELOG_SIGNATURE_INVALID',
      name,
    );
  }
  // Unsigned garbage is refused for its signature, not parsed.
  const garbage = await fetch(`${stack.api}/v1/webhooks/changelog/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(garbage.status, 401);
  for (const path of ['pending', 'releases']) {
    const response = await post(
      stack.api,
      path,
      { environment: 'production', version: VERSION, contained: [300] },
      { secret: 'another-changelog-secret-of-32-characters' },
    );
    assert.equal(response.status, 401, path);
  }
  assert.deepEqual(await entries(), before);
  assert.ok(
    stack.logs.some(
      (line) =>
        line.event === 'changelog_webhook.rejected' && line.route === 'drafts',
    ),
  );
});

test('a signed but malformed body is 400 and stores nothing', async () => {
  const before = await entries();
  for (const [path, body] of [
    ['drafts', '{not json'],
    ['drafts', { ...draft(320), mergeCommitSha: 'nope' }],
    ['drafts', { ...draft(320), extra: true }],
    ['pending', { environment: 'preview' }],
    [
      'releases',
      { environment: 'production', version: 'short', contained: [300] },
    ],
  ]) {
    const response = await post(stack.api, path, body);
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED');
  }
  assert.deepEqual(await entries(), before);
});

test('with no secret configured every changelog route is 404', async () => {
  for (const path of ['drafts', 'pending', 'releases']) {
    const response = await post(off.api, path, { environment: 'production' });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});

test('pending then releases marks only the numbers sent, and pending no longer lists them', async () => {
  for (const number of [330, 331])
    assert.equal((await post(stack.api, 'drafts', draft(number))).status, 200);
  const pending = await post(stack.api, 'pending', {
    environment: 'production',
  });
  assert.equal(pending.status, 200);
  const listed = (await pending.json()).data;
  assert.ok(listed.some((e) => e.number === 330 && e.mergeSha === sha(330)));
  assert.ok(listed.some((e) => e.number === 331));
  // Numbers and merge commits only.
  for (const entry of listed)
    assert.deepEqual(Object.keys(entry).sort(), ['mergeSha', 'number']);

  const released = await post(stack.api, 'releases', {
    environment: 'production',
    version: VERSION,
    contained: [330],
  });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { data: { marked: [330] } });
  // A replay is harmless.
  assert.deepEqual(
    await (
      await post(stack.api, 'releases', {
        environment: 'production',
        version: VERSION,
        contained: [330],
      })
    ).json(),
    { data: { marked: [] } },
  );
  const after = (
    await (
      await post(stack.api, 'pending', { environment: 'production' })
    ).json()
  ).data.map((e) => e.number);
  assert.ok(!after.includes(330));
  assert.ok(after.includes(331));
  const { rows } = await database.pool.query(
    'SELECT live_version FROM changelog_entries WHERE pr_number = 330',
  );
  assert.deepEqual(rows, [{ live_version: VERSION }]);
  // Staging is asked about separately: 330 has not been seen there.
  const staging = (
    await (await post(stack.api, 'pending', { environment: 'staging' })).json()
  ).data.map((e) => e.number);
  assert.ok(staging.includes(330));
});

test('a draft with a 64 KiB body is accepted; a body over 128 KiB is refused before parsing', async () => {
  const big = draft(340, {
    body: `Big one.\n\n## Notes\n${'x'.repeat(65_536 - 20)}`,
  });
  assert.ok(JSON.stringify(big).length > 16 * 1024);
  const accepted = await post(stack.api, 'drafts', big);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { data: { created: true } });

  const before = await entries();
  // Validly signed, so only the size can refuse it.
  const huge = await post(stack.api, 'drafts', {
    ...draft(341),
    body: 'y'.repeat(129 * 1024),
  });
  assert.equal(huge.status, 413);
  assert.deepEqual(await entries(), before);
});
