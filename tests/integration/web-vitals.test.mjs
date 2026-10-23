import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { purgeAnalytics } from '../../packages/database/dist/index.js';
import { WEB, opsSignIn, startStack } from './helpers.mjs';

// Real-user web vitals (PR-011, PRD §10.1): a metric name, a number and a page kind. Nothing else
// is accepted, nothing links one visit to another, and the Overview shows p75 against budget.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_ANALYTICS_PER_MIN: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const send = (body, headers = {}) =>
  fetch(`${stack.api}/v1/vitals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: WEB,
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari',
      ...headers,
    },
    body: JSON.stringify(body),
  });
const rows = () =>
  database.pool
    .query('SELECT metric, value, page, device FROM web_vitals ORDER BY value')
    .then((result) => result.rows);

test('a vital is stored as metric, value, page kind and device class only', async () => {
  assert.equal(
    (await send({ metric: 'LCP', value: 1834.6, page: 'profile' })).status,
    202,
  );
  assert.deepEqual(await rows(), [
    { metric: 'LCP', value: 1835, page: 'profile', device: 'mobile' },
  ]);
  const { rows: columns } = await database.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'web_vitals' ORDER BY 1`,
  );
  assert.deepEqual(
    columns.map((c) => c.column_name),
    ['at_minute', 'device', 'id', 'metric', 'page', 'value'],
  );
});

test('anything but the allow-list is refused, and GPC or DNT means nothing is stored', async () => {
  for (const body of [
    { metric: 'LCP', value: 1000, page: 'profile', url: '/@ada' },
    { metric: 'FID', value: 10, page: 'profile' },
    { metric: 'LCP', value: -1, page: 'profile' },
    { metric: 'LCP', value: 600001, page: 'profile' },
    { metric: 'CLS', value: 11, page: 'profile' },
    { metric: 'LCP', value: 1000, page: '/@ada' },
    { metric: 'LCP', value: '1000', page: 'profile' },
  ])
    assert.equal((await send(body)).status, 400, JSON.stringify(body));
  const before = (await rows()).length;
  await send({ metric: 'INP', value: 90, page: 'home' }, { 'sec-gpc': '1' });
  await send({ metric: 'INP', value: 90, page: 'home' }, { dnt: '1' });
  assert.equal((await rows()).length, before);
});

test('the Overview shows p75 per metric against the PRD budgets, and old samples are purged', async () => {
  await database.pool.query('DELETE FROM web_vitals');
  for (const value of [1000, 1500, 2000, 2500]) {
    await send({ metric: 'LCP', value, page: 'profile' });
    await send(
      { metric: 'LCP', value: value * 10, page: 'profile' },
      { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
    );
  }
  await send({ metric: 'CLS', value: 0.02, page: 'home' });
  const owner = await opsSignIn(stack.api, database.db, '+2348031110002');
  const health = await (
    await fetch(`${stack.api}/v1/ops/metrics/health`, {
      headers: { cookie: owner.cookie },
    })
  ).json();
  const vitals = Object.fromEntries(
    health.data.metrics.webVitals.map((v) => [v.metric, v]),
  );
  // Mobile visits only (PRD: mobile p75); the desktop samples are ten times slower.
  assert.deepEqual(vitals.LCP, {
    metric: 'LCP',
    p75: 2125,
    samples: 4,
    budget: 2000,
    withinBudget: false,
  });
  assert.deepEqual(vitals.CLS, {
    metric: 'CLS',
    p75: 0.02,
    samples: 1,
    budget: 0.05,
    withinBudget: true,
  });
  assert.deepEqual(vitals.INP, {
    metric: 'INP',
    p75: null,
    samples: 0,
    budget: 150,
    withinBudget: null,
  });

  await purgeAnalytics(database.db, { before: new Date(Date.now() + 60_000) });
  assert.equal((await rows()).length, 0);
});
