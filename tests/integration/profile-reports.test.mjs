import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// Reporting a page (PR-013, PRD v1.1 FR-01 "prevent impersonation with reporting and review").
// Anyone can report a live page with a reason from a fixed list; staff review it in the inbox.
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
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_REPORTS_PER_HOUR: '3',
      TRUST_PROXY_HOPS: '1',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  await fetch(`${stack.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ handle }),
  });
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'live' }),
  });
}

const report = (handle, body, ip = '198.51.100.7') =>
  fetch(`${stack.api}/v1/profiles/${handle}/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: WEB,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });

test('a visitor reports a page with a reason; staff see one issue for it, with the counts by reason', async () => {
  await livePage('+2348031270001', 'fake_ada');
  assert.equal(
    (await report('fake_ada', { reason: 'impersonation' })).status,
    202,
  );
  assert.equal(
    (await report('fake_ada', { reason: 'scam' }, '198.51.100.8')).status,
    202,
  );
  const { rows } = await database.pool.query(
    `SELECT reason FROM profile_reports ORDER BY reason`,
  );
  assert.deepEqual(
    rows.map((r) => r.reason),
    ['impersonation', 'scam'],
  );
  const { rows: columns } = await database.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'profile_reports' ORDER BY 1`,
  );
  assert.deepEqual(
    columns.map((c) => c.column_name),
    ['at_minute', 'id', 'profile_id', 'reason'],
    'no IP, user agent or free text',
  );

  const staff = await opsSignIn(stack.api, database.db, '+2348031270099');
  const list = await (
    await fetch(`${stack.api}/v1/ops/issues?kind=profile_reported`, {
      headers: { cookie: staff.cookie },
    })
  ).json();
  assert.equal(list.data.length, 1, 'one issue per page, however many reports');
  const [issue] = list.data;
  assert.equal(issue.severity, 'account');
  const evidence = await (
    await fetch(`${stack.api}/v1/ops/issues/${issue.id}`, {
      headers: { cookie: staff.cookie },
    })
  ).json();
  assert.deepEqual(evidence.data.pageReports, [
    { reason: 'impersonation', count: 1 },
    { reason: 'scam', count: 1 },
  ]);
});

test('anything but a reason from the list is refused; unknown pages and floods reveal nothing', async () => {
  await livePage('+2348031270002', 'real_tobi');
  for (const body of [
    {},
    { reason: 'spam' },
    { reason: 'impersonation', note: 'this is my ex' },
  ])
    assert.equal(
      // Invalid requests count against the limit too (no free probing), so their own address.
      (await report('real_tobi', body, '198.51.100.40')).status,
      400,
      JSON.stringify(body),
    );
  // Unknown, not live: the same answer as a real report, and nothing stored.
  assert.equal(
    (await report('nobody_here', { reason: 'scam' }, '198.51.100.20')).status,
    202,
  );
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM profile_reports r JOIN profiles p ON p.id = r.profile_id WHERE p.handle_lower = 'real_tobi'`,
  );
  assert.equal(rows[0].n, 0);
  // At most 3 an hour from one address (configurable), then 429.
  const statuses = [];
  for (let i = 0; i < 4; i++)
    statuses.push(
      (await report('real_tobi', { reason: 'other' }, '198.51.100.30')).status,
    );
  assert.deepEqual(statuses, [202, 202, 202, 429]);
});

test('many reports at once still open one issue, and old reports are purged after 180 days', async () => {
  await livePage('+2348031270003', 'busy_page');
  const ips = Array.from({ length: 8 }, (_, i) => `203.0.113.${i + 1}`);
  const statuses = await Promise.all(
    ips.map((ip) =>
      report('busy_page', { reason: 'scam' }, ip).then((r) => r.status),
    ),
  );
  assert.deepEqual(
    statuses,
    ips.map(() => 202),
  );
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE kind = 'profile_reported' AND status = 'open'
       AND subject->>'profileId' = (SELECT id::text FROM profiles WHERE handle_lower = 'busy_page')`,
  );
  assert.equal(rows[0].n, 1);

  const { purgeProfileReports } =
    await import('../../packages/database/dist/index.js');
  await database.pool.query(
    `UPDATE profile_reports SET at_minute = now() - interval '181 days'
      WHERE profile_id = (SELECT id FROM profiles WHERE handle_lower = 'busy_page')`,
  );
  const purged = await purgeProfileReports(database.db, { now: new Date() });
  assert.equal(purged, 8);
});
