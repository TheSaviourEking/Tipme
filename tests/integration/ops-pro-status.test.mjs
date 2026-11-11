import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

// Paid Pro, plan Task 4 (ADR-0015): staff who change plans see why a page is Pro and until when;
// the page lookup itself stays public-level.
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
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

test('the lookup has no billing fields; the pro route says staff grant or paid, and until when', async () => {
  const staff = await opsSignIn(stack.api, database.db, '+2348099990001');
  const get = (path) =>
    fetch(`${stack.api}${path}`, { headers: browserHeaders(staff.cookie) });
  const page = (await (await get('/v1/ops/pages/ada')).json()).data;
  assert.equal(page.profileId, ADA);
  assert.equal('proSource' in page, false);
  assert.deepEqual(
    (await (await get(`/v1/ops/pages/${ADA}/pro`)).json()).data,
    {
      proSource: null,
      paidUntil: null,
      graceUntil: null,
    },
  );
  const made = await fetch(`${stack.api}/v1/ops/pages/${ADA}/plan`, {
    method: 'POST',
    headers: browserHeaders(staff.cookie),
    body: JSON.stringify({ plan: 'pro', reason: 'Pilot recipient for Pro' }),
  });
  assert.equal(made.status, 200);
  assert.equal((await made.json()).data.proSource, 'staff');
  assert.equal(
    (await (await get(`/v1/ops/pages/${ADA}/pro`)).json()).data.proSource,
    'staff',
  );
});
