import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let owner;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348032220001');
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET'
        ? { cookie: owner.cookie }
        : browserHeaders(owner.cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => (await response.json()).data;
const entry = (extra = {}) => ({
  observedOn: '2026-10-01',
  category: 'competitor',
  name: 'PayTip',
  metric: 'Fee %',
  value: 5,
  sourceUrl: 'https://paytip.example/pricing',
  note: 'Pricing page, standard plan',
  ...extra,
});

test('an observation needs an https source; saving it is audited', async () => {
  const insecure = await call(
    'POST',
    '/v1/ops/market',
    entry({ sourceUrl: 'http://paytip.example/pricing' }),
  );
  assert.equal(insecure.status, 400);
  for (const bad of [
    entry({ category: 'rumour' }),
    entry({ name: '' }),
    entry({ observedOn: '2999-01-01' }),
    entry({ text: 'x'.repeat(501) }),
  ])
    assert.equal((await call('POST', '/v1/ops/market', bad)).status, 400);
  const saved = await call('POST', '/v1/ops/market', entry());
  assert.equal(saved.status, 201);
  const { id } = await json(saved);
  const audit = await json(await call('GET', '/v1/ops/audit'));
  assert.ok(
    audit.some((e) => e.action === 'market.added' && e.subjectId === id),
  );
});

test('a series is ordered by date; editing and archiving are audited and archived entries leave the list', async () => {
  const later = await json(
    await call(
      'POST',
      '/v1/ops/market',
      entry({ name: 'TipJarX', observedOn: '2026-10-10', value: 4 }),
    ),
  );
  await call(
    'POST',
    '/v1/ops/market',
    entry({ name: 'TipJarX', observedOn: '2026-09-10', value: 6 }),
  );
  const series = await json(
    await call('GET', '/v1/ops/market/series?name=TipJarX&metric=Fee%20%25'),
  );
  assert.deepEqual(
    series.map((p) => [p.observedOn, p.value]),
    [
      ['2026-09-10', 6],
      ['2026-10-10', 4],
    ],
  );
  const edited = await call('PATCH', `/v1/ops/market/${later.id}`, {
    value: 3.5,
    note: 'Promotional price',
  });
  assert.equal(edited.status, 200);
  assert.equal((await json(edited)).value, 3.5);
  assert.equal(
    (await call('POST', `/v1/ops/market/${later.id}/archive`, {})).status,
    200,
  );
  const list = await json(
    await call('GET', '/v1/ops/market?category=competitor'),
  );
  assert.equal(
    list.some((e) => e.id === later.id),
    false,
  );
  const audit = await json(await call('GET', '/v1/ops/audit'));
  for (const action of ['market.updated', 'market.archived'])
    assert.ok(
      audit.some((e) => e.action === action && e.subjectId === later.id),
      action,
    );
});

test('reading the market needs analytics.view; changing it needs market.edit', async () => {
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('analyst', 'Analyst') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('analyst', 'analytics.view') ON CONFLICT DO NOTHING`,
  );
  const analyst = await opsSignIn(stack.api, database.db, '+2348032220002');
  await database.pool.query(
    `UPDATE staff SET role_id = 'analyst' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348032220002')`,
  );
  assert.equal(
    (
      await fetch(`${stack.api}/v1/ops/market`, {
        headers: { cookie: analyst.cookie },
      })
    ).status,
    200,
  );
  const write = await fetch(`${stack.api}/v1/ops/market`, {
    method: 'POST',
    headers: browserHeaders(analyst.cookie),
    body: JSON.stringify(entry()),
  });
  assert.equal(write.status, 403);
});
