import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const TOKEN = 'release-check-token-for-integration-tests!';
let database;
let testCopy;
let liveCopy;
let noToken;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const common = { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' };
  testCopy = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...common, RELEASE_KIND: 'test', RELEASE_CHECK_TOKEN: TOKEN },
  });
  liveCopy = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...common, RELEASE_KIND: 'live', RELEASE_CHECK_TOKEN: TOKEN },
  });
  noToken = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...common, RELEASE_KIND: 'test' },
  });
});
after(async () => {
  for (const stack of [testCopy, liveCopy, noToken]) await stack.stop();
  await database.close();
});

const openRun = (api, token = TOKEN) =>
  fetch(`${api}/v1/release/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  });

test('a run is refused on a live copy, without a token, or with a wrong token (Review Focus 2)', async () => {
  assert.equal((await openRun(liveCopy.api)).status, 404);
  assert.equal((await openRun(noToken.api)).status, 404);
  assert.equal((await openRun(testCopy.api, null)).status, 404);
  assert.equal(
    (await openRun(testCopy.api, 'wrong-token-of-sufficient-length-xxxxxxxx'))
      .status,
    404,
  );
  assert.equal(
    (await database.pool.query('SELECT count(*)::int AS n FROM release_runs'))
      .rows[0].n,
    0,
  );
});

test('a run tags the page claimed with its header, and finishing it is idempotent', async () => {
  const response = await openRun(testCopy.api);
  assert.equal(response.status, 201);
  const { runId } = (await response.json()).data;
  const { cookie } = await signIn(testCopy.api, '+2348034440001');
  const claim = await fetch(`${testCopy.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie, { 'x-tipme-rehearsal': runId }),
    body: JSON.stringify({ handle: 'rc_check_one' }),
  });
  assert.equal(claim.status, 201);
  const [row] = (
    await database.pool.query(
      `SELECT rehearsal_run_id FROM profiles WHERE handle_lower = 'rc_check_one'`,
    )
  ).rows;
  assert.equal(row.rehearsal_run_id, runId);

  // On a live copy the header is ignored.
  const other = await signIn(liveCopy.api, '+2348034440002');
  await fetch(`${liveCopy.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(other.cookie, { 'x-tipme-rehearsal': runId }),
    body: JSON.stringify({ handle: 'rc_check_two' }),
  });
  const [two] = (
    await database.pool.query(
      `SELECT rehearsal_run_id FROM profiles WHERE handle_lower = 'rc_check_two'`,
    )
  ).rows;
  assert.equal(two.rehearsal_run_id, null);

  const finish = (token = TOKEN) =>
    fetch(`${testCopy.api}/v1/release/runs/${runId}/finish`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  assert.equal(
    (await finish('wrong-token-of-sufficient-length-xxxxxxxx')).status,
    404,
  );
  const done = await finish();
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).data, { issuesClosed: 0 });
  assert.equal((await finish()).status, 404, 'a finished run is gone');
});
