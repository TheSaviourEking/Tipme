import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadApiConfig } from '../dist/config.js';
import { RedisPartnerQuoteCache } from '../dist/infra/partner-quote-cache.js';

const SCOPE = { provider: 'mock', profileId: 'p1' };

/** The few Redis commands the cache uses, over a Map, recording each SET's expiry. */
function fakeRedis() {
  const values = new Map();
  const expiries = new Map();
  return {
    values,
    expiries,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, mode, seconds) {
      assert.equal(mode, 'EX');
      values.set(key, value);
      expiries.set(key, seconds);
      return 'OK';
    },
    multi() {
      const steps = [];
      const chain = {
        incr(key) {
          steps.push(() => {
            const next = Number(values.get(key) ?? 0) + 1;
            values.set(key, String(next));
            return next;
          });
          return chain;
        },
        expire(key, seconds) {
          steps.push(() => {
            expiries.set(key, seconds);
            return 1;
          });
          return chain;
        },
        async exec() {
          return steps.map((step) => [null, step()]);
        },
      };
      return chain;
    },
  };
}

const down = () => {
  const refuse = async () => {
    throw new Error(
      "Stream isn't writeable and enableOfflineQueue options is false",
    );
  };
  return {
    get: refuse,
    set: refuse,
    multi: () => ({
      incr() {
        return this;
      },
      expire() {
        return this;
      },
      exec: refuse,
    }),
  };
};

const stalled = () => {
  const never = () => new Promise(() => {});
  return {
    get: never,
    set: never,
    multi: () => ({
      incr() {
        return this;
      },
      expire() {
        return this;
      },
      exec: never,
    }),
  };
};

const cache = (redis, seconds = 30, budgetMs = 50) =>
  new RedisPartnerQuoteCache(redis, { prefix: 'it', seconds, budgetMs });

test('an entry is kept for the configured seconds, shared by key', async () => {
  const redis = fakeRedis();
  const entries = await cache(redis).open(SCOPE);
  await entries.set('base:x', 'v');
  assert.equal(await entries.get('base:x'), 'v');
  assert.equal(await (await cache(redis).open(SCOPE)).get('base:x'), 'v');
  const [key] = [...redis.expiries.keys()];
  assert.match(key, /^pq1:it:mock:p1:0:base:x$/);
  assert.equal(redis.expiries.get(key), 30);
});

test('another account never sees the entry', async () => {
  const redis = fakeRedis();
  await (await cache(redis).open(SCOPE)).set('base:x', 'v');
  const other = await cache(redis).open({ provider: 'mock', profileId: 'p2' });
  assert.equal(await other.get('base:x'), null);
});

test('invalidating raises the version, so nothing stored before is read', async () => {
  const redis = fakeRedis();
  const before = await cache(redis).open(SCOPE);
  await before.set('base:x', 'old');
  assert.equal(await cache(redis).invalidate(SCOPE), true);
  assert.equal(await (await cache(redis).open(SCOPE)).get('base:x'), null);
  // A read in flight across the invalidation stores under the old version: still unreachable.
  await before.set('base:x', 'stale');
  assert.equal(await (await cache(redis).open(SCOPE)).get('base:x'), null);
  // The version outlives every entry, so it can't lapse back to a version still holding one.
  assert.ok(redis.expiries.get('pq1:it:mock:p1:version') > 30);
});

test('Redis down: no entries, no errors, and invalidate says it failed', async () => {
  assert.equal(await cache(down()).open(SCOPE), null);
  assert.equal(await cache(down()).invalidate(SCOPE), false);
});

test('Redis stalled: gives up quickly instead of holding the quote', async () => {
  const started = performance.now();
  assert.equal(await cache(stalled()).open(SCOPE), null);
  assert.equal(await cache(stalled()).invalidate(SCOPE), false);
  assert.ok(performance.now() - started < 1000);
});

test('Redis failing after open: reads miss and writes are dropped quietly', async () => {
  const redis = fakeRedis();
  const entries = await cache(redis).open(SCOPE);
  redis.get = async () => {
    throw new Error('gone');
  };
  redis.set = async () => {
    throw new Error('gone');
  };
  assert.equal(await entries.get('base:x'), null);
  await entries.set('base:x', 'v');
});

test('0 seconds turns the cache off', async () => {
  const redis = fakeRedis();
  assert.equal(await cache(redis, 0).open(SCOPE), null);
});

test('PARTNER_QUOTE_CACHE_SECONDS defaults to 30 and refuses nonsense', () => {
  const valid = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    STATUS_TOKEN_SECRET: 's'.repeat(32),
    AUTH_CODE_SECRET: 'a'.repeat(32),
    WEB_REVALIDATE_SECRET: 'r'.repeat(32),
    OPS_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
    MAIL_SEAL_KEY: Buffer.alloc(32, 2).toString('base64'),
    NODE_ENV: 'test',
  };
  assert.equal(loadApiConfig(valid).PARTNER_QUOTE_CACHE_SECONDS, 30);
  assert.equal(
    loadApiConfig({ ...valid, PARTNER_QUOTE_CACHE_SECONDS: '0' })
      .PARTNER_QUOTE_CACHE_SECONDS,
    0,
  );
  assert.throws(
    () => loadApiConfig({ ...valid, PARTNER_QUOTE_CACHE_SECONDS: '-1' }),
    /PARTNER_QUOTE_CACHE_SECONDS/,
  );
  assert.throws(
    () => loadApiConfig({ ...valid, PARTNER_QUOTE_CACHE_SECONDS: '3600' }),
    /PARTNER_QUOTE_CACHE_SECONDS/,
  );
});

test('one quote spends one Redis budget in all, then every read is a miss', async () => {
  const redis = fakeRedis();
  await (await cache(redis).open(SCOPE)).set('base:x', 'v');
  const slow = (ms) => (value) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const get = redis.get.bind(redis);
  redis.get = async (key) => slow(30)(await get(key));
  const started = performance.now();
  const entries = await cache(redis, 30, 100).open(SCOPE);
  const reads = [];
  for (let i = 0; i < 6; i++) reads.push(await entries.get('base:x'));
  // Each read alone fits the budget, but six of them don't: later ones miss without asking.
  assert.ok(performance.now() - started < 200);
  assert.equal(reads[0], 'v');
  assert.equal(reads.at(-1), null);
});

test('a write is never waited for', async () => {
  const redis = stalled();
  const fake = fakeRedis();
  redis.get = fake.get;
  const entries = await cache(redis).open(SCOPE);
  const started = performance.now();
  await entries.set('base:x', 'v');
  assert.ok(performance.now() - started < 20);
});

test('with the cache off, invalidating sends nothing', async () => {
  const redis = fakeRedis();
  let sent = 0;
  redis.multi = () => {
    sent += 1;
    return fakeRedis().multi();
  };
  assert.equal(await cache(redis, 0).invalidate(SCOPE), true);
  assert.equal(sent, 0);
});
