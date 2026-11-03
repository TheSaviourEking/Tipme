import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import {
  getFreePort,
  InMemorySpanExporter,
} from '../../packages/observability/dist/testing.js';
import {
  createDatabase,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { runMigrations } from '../../packages/database/dist/migrations.js';
import {
  AUTH_CODE_SECRET,
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  REDIS_URL,
  STATUS_TOKEN_SECRET,
  WEBHOOK_SECRET,
} from './helpers.mjs';

const pg = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
)('pg');

// The real thing: Postgres started with a small max_connections, six API copies (both colours) and
// two workers, at the sizes they work out for themselves, and the server's own count watched.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const NAME = `tipme-budget-${process.pid}`;
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const haveDocker = docker('info').status === 0;
const skip = haveDocker ? false : 'needs Docker';

const port = await getFreePort();
const adminUrl = `postgres://postgres:budget_admin_pw@127.0.0.1:${port}/tipme`;
const appUrl = () => `postgres://tipme_app:budget_pw@127.0.0.1:${port}/tipme`;

async function admin(run) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function untilUp() {
  for (let i = 0; i < 120; i += 1) {
    try {
      await admin((c) => c.query('SELECT 1'));
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('test Postgres did not start');
}

function startServer() {
  docker('rm', '-f', NAME);
  const started = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '-e',
    'POSTGRES_PASSWORD=budget_admin_pw',
    '-e',
    'POSTGRES_DB=tipme',
    '-p',
    `127.0.0.1:${port}:5432`,
    'postgres:16.13-alpine',
  );
  assert.equal(started.status, 0, started.stderr);
}

async function prepare() {
  await untilUp();
  // Twice: the image restarts itself once after initialising.
  await sleep(500);
  await untilUp();
  const handle = createDatabase(adminUrl, { max: 2 });
  await runMigrations(handle.db);
  await seedDemoProfiles(handle.db);
  await handle.close();
  await admin(async (c) => {
    await c.query(`CREATE ROLE tipme_app LOGIN PASSWORD 'budget_pw'`);
    await c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO tipme_app`);
    await c.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO tipme_app`);
  });
}

function collector() {
  const logs = [];
  return {
    logs,
    logDestination: new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split('\n'))
          logs.push(JSON.parse(line));
        done();
      },
    }),
  };
}

const prefix = () => `b${randomUUID().slice(0, 8)}`;

/** Six API copies and two workers, as production at its worst moment. */
async function startFleet(env = {}, counts = { api: 6, workers: 2 }) {
  const { createApp } = await import('../../apps/api/dist/app.factory.js');
  const { loadApiConfig } = await import('../../apps/api/dist/config.js');
  const { startJobWorker } =
    await import('../../apps/worker/dist/job-worker.js');
  const { loadWorkerConfig } = await import('../../apps/worker/dist/config.js');
  const queue = prefix();
  const common = {
    NODE_ENV: 'test',
    REDIS_URL,
    QUEUE_PREFIX: queue,
    LOG_LEVEL: 'info',
    MAIL_SEAL_KEY,
    DATABASE_URL: appUrl(),
    DATABASE_BUDGET_API_PROCESSES: '6',
    DATABASE_BUDGET_WORKER_PROCESSES: '2',
    DATABASE_BUDGET_MARGIN: '7',
    ...env,
  };
  const out = collector();
  const apps = [];
  for (let i = 0; i < counts.api; i += 1) {
    const app = await createApp(
      loadApiConfig({
        ...common,
        MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STATUS_TOKEN_SECRET,
        AUTH_CODE_SECRET,
        WEB_REVALIDATE_SECRET: 'integration-revalidate-secret-32-characters',
        OPS_TOTP_KEY,
        RATE_LIMIT_QUOTES_PER_MIN: '100000',
        RATE_LIMIT_INTENTS_PER_MIN: '100000',
      }),
      { logDestination: out.logDestination },
    );
    await app.listen(0, '127.0.0.1');
    apps.push(await app.getUrl().then((origin) => ({ app, origin })));
  }
  const workers = [];
  for (let i = 0; i < counts.workers; i += 1)
    workers.push(
      await startJobWorker(
        loadWorkerConfig({
          ...common,
          MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
          RECONCILE_INTERVAL_MS: '500',
          RECONCILE_MIN_AGE_MS: '0',
        }),
        { logDestination: out.logDestination },
      ),
    );
  return {
    apps,
    logs: out.logs,
    async stop() {
      for (const worker of workers) await worker.close();
      for (const { app } of apps) await app.close();
    },
  };
}

const quote = (origin) =>
  fetch(`${origin}/v1/tip-quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: 'ada',
      amountMinor: '200000',
      currency: 'NGN',
    }),
  }).then((response) => response.status);

/** Hammers every copy and returns the most sessions the server showed for the app's role. */
async function loadAndWatch(fleet, rounds = 8, perCopy = 8) {
  let peak = 0;
  let loading = true;
  const watching = admin(async (client) => {
    while (loading) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'tipme_app'`,
      );
      peak = Math.max(peak, rows[0].n);
      await sleep(20);
    }
  });
  const statuses = [];
  for (let round = 0; round < rounds; round += 1)
    statuses.push(
      ...(await Promise.all(
        fleet.apps.flatMap(({ origin }) =>
          Array.from({ length: perCopy }, () => quote(origin)),
        ),
      )),
    );
  loading = false;
  await watching;
  return { peak, statuses };
}

const budgetLines = (fleet, role) =>
  fleet.logs.filter(
    (line) => line.event === 'database.budget' && line.role === role,
  );

before(() => {
  process.on('exit', () => docker('rm', '-f', NAME));
});
after(() => {
  docker('rm', '-f', NAME);
});

test(
  'at max_connections=20 both colours stay inside the budget under load',
  { skip },
  async () => {
    startServer();
    await prepare();
    await changeLimit(20);
    const fleet = await startFleet();
    try {
      const api = budgetLines(fleet, 'api').at(-1);
      assert.equal(api.source, 'computed');
      assert.equal(api.max_connections, 20);
      assert.equal(api.reserved, 3);
      assert.equal(api.usable, 10);
      assert.equal(api.pool_max, 1);
      assert.equal(budgetLines(fleet, 'worker').at(-1).pool_max, 2);
      assert.ok(!JSON.stringify(fleet.logs).includes('budget_pw'));
      const { peak, statuses } = await loadAndWatch(fleet);
      assert.ok(peak <= 10, `peak ${peak}`);
      assert.deepEqual([...new Set(statuses)], [201]);
      assert.ok(!fleet.logs.some((l) => l.sql_state === '53300'));
    } finally {
      await fleet.stop();
    }
  },
);

async function changeLimit(maxConnections) {
  await admin((c) =>
    c.query(`ALTER SYSTEM SET max_connections = ${Number(maxConnections)}`),
  );
  assert.equal(docker('restart', NAME).status, 0);
  await untilUp();
}

const until = async (check, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
};

test(
  'a limit changed while running is picked up with no restart, up and down',
  { skip },
  async () => {
    const fleet = await startFleet(
      { DATABASE_BUDGET_REFRESH_MS: '300' },
      { api: 6, workers: 2 },
    );
    try {
      assert.equal(budgetLines(fleet, 'api').at(-1).pool_max, 1);
      await changeLimit(50);
      assert.ok(
        await until(() => budgetLines(fleet, 'api').at(-1).pool_max === 4),
        JSON.stringify(budgetLines(fleet, 'api').at(-1)),
      );
      assert.equal(budgetLines(fleet, 'worker').at(-1).pool_max, 4);
      const raised = await loadAndWatch(fleet, 6, 12);
      assert.ok(raised.peak <= 32, `peak ${raised.peak}`);
      assert.ok(
        raised.peak > 10,
        `the new room was never used: ${raised.peak}`,
      );
      assert.deepEqual([...new Set(raised.statuses)], [201]);

      await changeLimit(20);
      assert.ok(
        await until(() => budgetLines(fleet, 'api').at(-1).pool_max === 1),
      );
      const lowered = await loadAndWatch(fleet);
      assert.ok(lowered.peak <= 10, `peak ${lowered.peak}`);
      assert.deepEqual([...new Set(lowered.statuses)], [201]);
    } finally {
      await fleet.stop();
    }
  },
);

test(
  'a tiny limit clamps to one connection each, says so, and answers cleanly without deadlock',
  { skip },
  async () => {
    await changeLimit(10); // 7 for ordinary roles, and the minimums want 8 mid-deploy.
    const fleet = await startFleet();
    try {
      const api = budgetLines(fleet, 'api').at(-1);
      assert.equal(api.max_connections, 10);
      assert.equal(api.usable, 0);
      assert.equal(api.pool_max, 1);
      assert.equal(api.overcommitted, true);
      assert.equal(budgetLines(fleet, 'worker').at(-1).pool_max, 1);
      const { statuses } = await loadAndWatch(fleet, 4, 4);
      assert.deepEqual(
        [...new Set(statuses)].filter((s) => s !== 201 && s !== 503),
        [],
      );
      assert.ok(statuses.includes(201), 'nothing got through at the minimum');
    } finally {
      await fleet.stop();
    }
  },
);

test('a read that fails boots on the small default and logs it', async () => {
  const closed = await getFreePort();
  const fleet = await startFleet(
    {
      DATABASE_URL: `postgres://tipme_app:budget_pw@127.0.0.1:${closed}/tipme`,
    },
    { api: 1, workers: 1 },
  );
  try {
    const failed = fleet.logs.filter(
      (line) => line.event === 'database.budget_read_failed',
    );
    assert.equal(failed.length, 2, 'one for each process');
    assert.equal(failed[0].cause, 'network');
    assert.equal(failed[0].errno, 'ECONNREFUSED');
    assert.equal(failed[0].keeping_pool_max, 1);
    const line = budgetLines(fleet, 'api').at(-1);
    assert.equal(line.source, 'fallback');
    assert.equal(line.pool_max, 1);
    assert.equal(
      (await fetch(`${fleet.apps[0].origin}/health/ready`)).status,
      503,
    );
    assert.equal((await fetch(`${fleet.apps[0].origin}/health`)).status, 200);
  } finally {
    await fleet.stop();
  }
});

test('an override wins over the computed size', async () => {
  const closed = await getFreePort();
  const fleet = await startFleet(
    {
      DATABASE_URL: `postgres://tipme_app:budget_pw@127.0.0.1:${closed}/tipme`,
      DATABASE_POOL_MAX: '3',
    },
    { api: 1, workers: 0 },
  );
  try {
    const line = budgetLines(fleet, 'api').at(-1);
    assert.equal(line.source, 'override');
    assert.equal(line.pool_max, 3);
  } finally {
    await fleet.stop();
  }
});
