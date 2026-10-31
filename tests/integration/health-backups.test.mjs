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
  // The newest retention run, blocked by a WAL gap and a stale drill: reasons name segments.
  await database.pool.query(
    `INSERT INTO backup_retention_runs (id, ran_at, mode, outcome, blocked, retained_backups,
       boundary, archive_bytes, candidate_bytes, deleted_bytes, disk_free_bytes, disk_total_bytes)
     VALUES (gen_random_uuid(), now() - interval '10 minutes', 'dry-run', 'planned', $1, 4,
       '0000000100000005000000A1', 27000000000, 13000000000, 0, 11000000000, 48000000000)`,
    [
      'WAL gap: 0000000100000006000000AB is missing, so kept backups can’t be restored past it\nno passing recovery drill in the last 7 days',
    ],
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
  assert.equal(body.pointInTime, true, 'expected unless switched off');
  assert.deepEqual(body.retention, {
    lastRunAgeMinutes: body.retention.lastRunAgeMinutes,
    mode: 'dry-run',
    outcome: 'planned',
    blocked: ['wal-gap', 'no-drill'],
    archiveBytes: 27000000000,
    candidateBytes: 13000000000,
    diskFreePercent: 23,
  });
  assert.ok(
    body.retention.lastRunAgeMinutes >= 9 &&
      body.retention.lastRunAgeMinutes <= 11,
  );
  assert.equal(
    JSON.stringify(body).includes('000000010000'),
    false,
    'no segment names',
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
