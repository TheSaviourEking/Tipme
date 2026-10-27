#!/usr/bin/env node
// Load test (PR-011, PRD §10.1). Starts a throwaway API + worker from this checkout's build on its
// own scratch database (the demo pages seeded), signs in a demo recipient, and runs k6 (pinned
// image) against it. Exits non-zero when any PRD budget is missed.
//
//   pnpm build && node scripts/load-test.mjs            (needs Docker, local Postgres and Redis)
//   LOAD_RATE=40 LOAD_DURATION=60s node scripts/load-test.mjs
//
// Local only, by design: checkout initialisation writes quotes and pending tips.
//
// Missed budgets (k6 exit 99) get one more run before failing: a shared CI machine can be several
// times slower for a minute, and a real slowdown misses the budgets on both runs.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { openTestDatabase } from '../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../packages/database/dist/index.js';
import { signIn, startStack } from '../tests/integration/helpers.mjs';

export const K6_IMAGE =
  'grafana/k6:1.0.0@sha256:f21270290d702cbf0a7d6ba5d7ed100b63bcb233b558b885ed787547b3488279';

/** k6 exits 99 when thresholds (the budgets) are crossed; anything else is final. */
const BUDGETS_MISSED = 99;

export async function withOneRetry(run, log) {
  const first = await run();
  if (first !== BUDGETS_MISSED) return first;
  log(
    'Budgets missed; running the load test once more to rule out a slow machine.',
  );
  return run();
}

async function main() {
  const database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const generous = '1000000';
  // k6 reaches the API on the host's loopback: the host network on Linux (CI),
  // host.docker.internal on Docker Desktop.
  const linux = process.platform === 'linux';
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      LOG_LEVEL: 'warn',
      RATE_LIMIT_AUTH_PER_HOUR: generous,
      RATE_LIMIT_QUOTES_PER_MIN: generous,
      RATE_LIMIT_INTENTS_PER_MIN: generous,
      RATE_LIMIT_HANDLES_PER_MIN: generous,
      RATE_LIMIT_ANALYTICS_PER_MIN: generous,
    },
  });
  let status = 1;
  try {
    const { cookie } = await signIn(
      `http://127.0.0.1:${new URL(stack.api).port}`,
      '+2348000000002',
    ); // demo recipient @tobi
    const port = new URL(stack.api).port;
    const api = `http://${linux ? '127.0.0.1' : 'host.docker.internal'}:${port}`;
    const env = {
      LOAD_API: api,
      LOAD_HANDLE: 'tobi',
      LOAD_COOKIE: cookie,
      LOAD_RATE: process.env.LOAD_RATE ?? '20',
      LOAD_DURATION: process.env.LOAD_DURATION ?? '30s',
      LOAD_BUDGET_SCALE: process.env.LOAD_BUDGET_SCALE ?? '1',
    };
    // Async: the API runs in this process and must keep serving while k6 runs.
    const k6 = () => {
      const run = spawn(
        'docker',
        [
          'run',
          '--rm',
          ...(linux ? ['--network', 'host'] : []),
          '-v',
          `${resolve('tests/load')}:/load:ro`,
          ...Object.keys(env).flatMap((key) => ['-e', key]),
          K6_IMAGE,
          'run',
          '--quiet',
          '/load/tipme.k6.js',
        ],
        { stdio: 'inherit', env: { ...process.env, ...env } },
      );
      return new Promise((done) => run.on('close', (code) => done(code ?? 1)));
    };
    status = await withOneRetry(k6, console.log);
    console.log(
      status === 0
        ? 'Load test PASSED: every PRD §10.1 budget held.'
        : `Load test FAILED (k6 exit ${status}).`,
    );
  } finally {
    await stack.stop();
    await database.close();
  }
  return status;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
