import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { startStack } from './helpers.mjs';

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
      WEB_ORIGIN: 'https://staging.example.test',
      DEPLOYMENT_MODE: 'preview',
      PREVIEW_PASSWORD: 'staging-preview-password-for-tests-only!',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

test('backup health is public (for alerts), shows only times and counts, and works behind the preview gate', async () => {
  await database.pool.query(
    `INSERT INTO backup_runs (id, kind, file, version, finished_at)
     VALUES (gen_random_uuid(), 'logical', 'tipme-20261021T010000Z-abc.dump.enc', 'abc', now() - interval '2 hours')`,
  );
  const response = await fetch(`${stack.api}/health/backups`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()).data;
  assert.ok(body.logical.ageMinutes >= 119 && body.logical.ageMinutes <= 121);
  assert.equal(body.base, null);
  assert.equal(typeof body.wal.archiving, 'boolean');
  assert.equal(typeof body.wal.failedCount, 'number');
  assert.equal(
    JSON.stringify(body).includes('tipme-2026'),
    false,
    'no file names',
  );
});

test('backup health is answered from a 30-second cache, so a flood of requests costs no queries', async () => {
  const first = (await (await fetch(`${stack.api}/health/backups`)).json())
    .data;
  await database.pool.query(
    `INSERT INTO backup_runs (id, kind, file, version, finished_at)
     VALUES (gen_random_uuid(), 'base', 'tipme-base-x.tar.enc', 'abc', now())`,
  );
  const second = (await (await fetch(`${stack.api}/health/backups`)).json())
    .data;
  assert.deepEqual(second.base, first.base, 'still the cached answer');
});
