#!/usr/bin/env node
// Runs the integration suite with test files in parallel: each test process works in its own
// copy of one migrated template database, so files no longer wait for each other.
//
//   pnpm test:integration                      (after a build; local Postgres and Redis)
//   TEST_CONCURRENCY=4 TEST_SHARD=2/3 node scripts/test-integration.mjs
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

export const INTEGRATION_FILES = [
  'packages/database/test/integration/*.test.mjs',
  'packages/payments/test/integration/*.test.mjs',
  'tests/integration/*.test.mjs',
];
const TEMPLATE = 'tipme_it';

export function nodeTestArgs({ concurrency, shard }) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(`bad concurrency: ${concurrency}`);
  if (shard !== undefined) {
    const [index, total] = (/^(\d+)\/(\d+)$/.exec(shard) ?? [])
      .slice(1)
      .map(Number);
    if (!(index >= 1 && total >= 1 && index <= total))
      throw new Error(`bad shard: ${shard} (expected i/n)`);
  }
  return [
    '--import',
    './packages/observability/dist/register.js',
    '--test',
    `--test-concurrency=${concurrency}`,
    ...(shard ? [`--test-shard=${shard}`] : []),
    ...INTEGRATION_FILES,
  ];
}

async function main() {
  const { prepareTestTemplate, dropTestDatabases } =
    await import('../packages/database/dist/test-support.js');
  const args = nodeTestArgs({
    concurrency: Number(
      process.env.TEST_CONCURRENCY ?? Math.max(2, availableParallelism()),
    ),
    shard: process.env.TEST_SHARD || undefined,
  });
  await prepareTestTemplate(TEMPLATE);
  try {
    const run = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, TIPME_TEST_TEMPLATE: TEMPLATE },
    });
    return await new Promise((done) =>
      run.on('close', (code) => done(code ?? 1)),
    );
  } finally {
    await dropTestDatabases(TEMPLATE);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
