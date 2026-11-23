import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import { createMockProvider } from '../dist/index.js';

// The second test adapter: the same pretend provider under another name and its own keys, so
// integration tests can hold money at two providers. Local Redis, as the integration tests use.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
after(() => redis.quit());
const prefix = () => `t-${randomUUID().slice(0, 8)}`;

test('name is mock_alt', () => {
  assert.equal(createMockProvider({ redis, prefix: prefix() }).name, 'mock');
  assert.equal(
    createMockProvider({ redis, prefix: prefix(), name: 'mock_alt' }).name,
    'mock_alt',
  );
});

test('mock_alt keys never collide with mock', async () => {
  const shared = prefix();
  const mock = createMockProvider({ redis, prefix: shared });
  const alt = createMockProvider({ redis, prefix: shared, name: 'mock_alt' });
  const payoutId = randomUUID();
  const idempotencyKey = randomUUID();
  await mock.initiatePayout({
    payoutId,
    idempotencyKey,
    amountMinor: 1000n,
    currency: 'NGN',
    scenario: 'payout-review',
  });
  // Same ids, different details: a shared key would refuse this as a reused key.
  await alt.initiatePayout({
    payoutId,
    idempotencyKey,
    amountMinor: 2000n,
    currency: 'NGN',
  });
  const reference = `mock_out_${idempotencyKey}`;
  assert.equal((await mock.fetchPayoutStatus(reference)).status, 'review');
  assert.equal((await alt.fetchPayoutStatus(reference)).status, 'pending');
  const keys = await redis.keys(`*${shared}*`);
  assert.ok(keys.some((key) => key.includes(`${shared}:mock_alt`)));
  assert.ok(
    keys.some((key) => !key.includes(`${shared}:mock_alt`)),
    'mock keeps its own keys',
  );
});

test('markPayoutBalance sets and clears the figure for one account only', async () => {
  const alt = createMockProvider({
    redis,
    prefix: prefix(),
    name: 'mock_alt',
  });
  const pretend = (await alt.payoutBalance('acct_b', 'NGN')).availableMinor;
  await alt.markPayoutBalance('acct_a', 5_000n);
  assert.equal(
    (await alt.payoutBalance('acct_a', 'NGN')).availableMinor,
    5_000n,
  );
  assert.equal(
    (await alt.payoutBalance('acct_b', 'NGN')).availableMinor,
    pretend,
  );
  await alt.markPayoutBalance('acct_a', 0n);
  assert.equal((await alt.payoutBalance('acct_a', 'NGN')).availableMinor, 0n);
  await alt.markPayoutBalance('acct_a', null);
  assert.equal(
    (await alt.payoutBalance('acct_a', 'NGN')).availableMinor,
    pretend,
  );
});
