import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redisMailHealthStore } from '../../packages/mail/dist/index.js';
import { runHealthStoreCases } from '../../packages/mail/test/fixtures/health-store-cases.mjs';
import { Redis, REDIS_URL, uniquePrefix } from './helpers.mjs';

// The mail breaker's state lives in Redis so the API and every worker agree (automatic failover,
// owner 23 Nov 2026). Its Lua scripts must follow exactly the rules the in-process store does:
// the same cases run against both.

const redis = new Redis(REDIS_URL);
test.after(() => redis.quit());

runHealthStoreCases(
  test,
  (settings) =>
    redisMailHealthStore(redis, { ...settings, prefix: uniquePrefix() }),
  'redis',
);

test('redis: a lost state is a healthy provider, and nothing is kept forever', async () => {
  const prefix = uniquePrefix();
  const store = redisMailHealthStore(redis, {
    threshold: 3,
    windowMs: 300_000,
    restMs: 900_000,
    trialCodes: 3,
    prefix,
  });
  await store.trip('zeptomail', Date.now(), 'x', 'codes');
  const ttl = await redis.pttl(`${prefix}:mail-health:zeptomail`);
  assert.ok(ttl > 0 && ttl <= 30 * 86_400_000, `ttl ${ttl}`);
  // Redis restarted without the key: healthy, normal behaviour.
  await redis.del(`${prefix}:mail-health:zeptomail`);
  assert.equal((await store.read(['zeptomail'])).has('zeptomail'), false);
  assert.equal(await store.claim('zeptomail', Date.now(), true), false);
});

test('redis: concurrent processes share one probe', async () => {
  const prefix = uniquePrefix();
  const settings = {
    threshold: 3,
    windowMs: 300_000,
    restMs: 1000,
    trialCodes: 3,
    prefix,
  };
  const a = redisMailHealthStore(redis, settings);
  const b = redisMailHealthStore(redis, settings);
  const now = Date.now();
  await a.trip('brevo', now, 'x', 'send');
  const claims = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? a : b).claim('brevo', now + 2000, false),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
});
