import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Photo uploads are expensive (decode + re-encode), so they are rate-limited (PR-013 review).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');

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
      RATE_LIMIT_AVATARS_PER_HOUR: '2',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

test('photo uploads are limited per hour', async () => {
  const { cookie } = await signIn(stack.api, '+2348031280010');
  await fetch(`${stack.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ handle: 'photo_limit' }),
  });
  const body = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#7A32F9' },
  })
    .png()
    .toBuffer();
  const statuses = [];
  for (let i = 0; i < 3; i++)
    statuses.push(
      (
        await fetch(`${stack.api}/v1/me/avatar`, {
          method: 'PUT',
          headers: { ...browserHeaders(cookie), 'content-type': 'image/png' },
          body,
        })
      ).status,
    );
  assert.deepEqual(statuses, [200, 200, 429]);
});
