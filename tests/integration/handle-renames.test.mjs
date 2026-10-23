import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Handle renames (PR-011, FR-015): old handles stay with the page as permanent aliases, so printed
// QR codes keep working and nobody else can take them over.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let revalidations = [];
let revalidateServer;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      revalidations.push(JSON.parse(raw).handle);
      response.writeHead(200).end('{}');
    });
  });
  await new Promise((resolve) =>
    revalidateServer.listen(0, '127.0.0.1', resolve),
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
  revalidateServer.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    redirect: 'manual',
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  assert.equal(
    (await call('POST', '/v1/me/page', cookie, { handle })).status,
    201,
  );
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  return cookie;
}

const rename = (cookie, handle) =>
  call('PUT', '/v1/me/handle', cookie, { handle });

test('a renamed page answers on its new handle, and the old one points there for good', async () => {
  const cookie = await livePage('+2348031250001', 'ada_old');
  revalidations = [];
  const renamed = await rename(cookie, 'Ada_New');
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).data.handle, 'ada_new');
  assert.equal((await call('GET', '/v1/profiles/ada_new')).status, 200);

  const old = await call('GET', '/v1/profiles/ADA_OLD');
  assert.equal(old.status, 308);
  assert.equal(old.headers.get('location'), '/v1/profiles/ada_new');
  assert.deepEqual((await old.json()).data, { movedTo: 'ada_new' });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(revalidations.sort(), ['ada_new', 'ada_old']);
  // Once more for the old handle a little later: a render of the old page already in flight
  // could otherwise cache it again, and its tip button would fail for up to 30 seconds.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.deepEqual(revalidations.sort(), ['ada_new', 'ada_old', 'ada_old']);

  // Nobody else can take the old handle.
  const status = await call('GET', '/v1/handles/ada_old/availability');
  assert.equal((await status.json()).data.status, 'taken');
  const other = await signIn(stack.api, '+2348031250002');
  const grab = await call('POST', '/v1/me/page', other.cookie, {
    handle: 'ada_old',
  });
  assert.equal(grab.status, 409);
  assert.equal((await grab.json()).error.code, 'HANDLE_TAKEN');
  assert.equal(
    (await rename(other.cookie, 'ada_old')).status,
    404,
    'no page yet',
  );
});

test('renaming back to an old handle works without a redirect loop; case-only changes add no alias', async () => {
  const cookie = await livePage('+2348031250003', 'loop_a');
  assert.equal((await rename(cookie, 'loop_b')).status, 200);
  assert.equal((await rename(cookie, 'loop_a')).status, 200);
  assert.equal((await call('GET', '/v1/profiles/loop_a')).status, 200);
  const b = await call('GET', '/v1/profiles/loop_b');
  assert.equal(b.status, 308);
  assert.equal(b.headers.get('location'), '/v1/profiles/loop_a');
  const cased = await rename(cookie, 'Loop_A');
  assert.equal(cased.status, 200);
  assert.equal((await cased.json()).data.handle, 'loop_a');
  const { rows } = await database.pool.query(
    `SELECT handle_lower FROM handle_aliases ORDER BY handle_lower`,
  );
  assert.deepEqual(
    rows.map((r) => r.handle_lower).filter((h) => h.startsWith('loop')),
    ['loop_b'],
  );
});

test('a page keeps at most five old handles; taken, reserved and invalid handles are refused', async () => {
  const cookie = await livePage('+2348031250004', 'many_0');
  for (let i = 1; i <= 5; i++)
    assert.equal(
      (await rename(cookie, `many_${i}`)).status,
      200,
      `rename ${i}`,
    );
  const sixth = await rename(cookie, 'many_6');
  assert.equal(sixth.status, 409);
  assert.equal((await sixth.json()).error.code, 'HANDLE_RENAME_LIMIT');
  // Going back to one of its own old handles is still allowed (it swaps places).
  assert.equal((await rename(cookie, 'many_0')).status, 200);

  await livePage('+2348031250005', 'someone');
  assert.equal((await rename(cookie, 'someone')).status, 409);
  assert.equal((await rename(cookie, 'admin')).status, 409);
  assert.equal((await rename(cookie, 'no spaces!')).status, 400);
});

test('an old handle of a page that is not live reveals nothing, and deleting the page holds its old handles', async () => {
  const cookie = await livePage('+2348031250006', 'quiet_old');
  await rename(cookie, 'quiet_new');
  await call('PUT', '/v1/me/page/state', cookie, { state: 'not_live' });
  const old = await call('GET', '/v1/profiles/quiet_old');
  assert.equal(old.status, 404);
  assert.equal(old.headers.get('location'), null);

  assert.equal(
    (await call('DELETE', '/v1/me/account', cookie, { confirm: 'DELETE' }))
      .status,
    204,
  );
  for (const handle of ['quiet_old', 'quiet_new']) {
    const status = await call('GET', `/v1/handles/${handle}/availability`);
    assert.equal((await status.json()).data.status, 'taken', handle);
  }
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM handle_aliases WHERE handle_lower LIKE 'quiet%'`,
  );
  assert.equal(rows[0].n, 0, 'aliases became ordinary 90-day holds');
});

test('the database itself refuses another page an old handle (a rolled-back release cannot hand it out)', async () => {
  const cookie = await livePage('+2348031250007', 'guard_old');
  assert.equal((await rename(cookie, 'guard_new')).status, 200);
  await livePage('+2348031250008', 'guard_other');
  // What the previous release's claim or rename would do: write the handle without checking aliases.
  await assert.rejects(
    database.pool.query(
      `UPDATE profiles SET handle = 'guard_old', handle_lower = 'guard_old' WHERE handle_lower = 'guard_other'`,
    ),
    (error) => error.code === '23505',
  );
  // The page that owns the alias can still take it back.
  assert.equal((await rename(cookie, 'guard_old')).status, 200);
});
