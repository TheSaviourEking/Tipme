import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const WEB = 'http://localhost:3000';
let database;
let stack;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  // Generous limits for the functional tests; the limit itself is tested on its own stack.
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function post(api, path, body, headers = {}) {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

const quote = (api, amountMinor = '100000', handle = 'ada') =>
  post(api, '/v1/tip-quotes', { handle, amountMinor, currency: 'NGN' });
const intent = (api, body, key = randomUUID()) =>
  post(api, '/v1/tip-intents', body, { 'idempotency-key': key });

test('a quote shows what the recipient receives', async () => {
  const { status, body } = await quote(stack.api);
  assert.equal(status, 201);
  assert.equal(body.data.recipientNetMinor, '93500');
  assert.equal(body.data.tipMinor, '100000');
  assert.equal(body.data.displayName.length > 0, true);
  assert.equal(body.data.handle, 'ada');
  assert.equal(body.data.currency, 'NGN');
});

test('quotes for unknown profiles and invalid amounts are refused', async () => {
  const unknown = await quote(stack.api, '100000', 'nobody-here');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'PROFILE_NOT_FOUND');
  const small = await quote(stack.api, '50');
  assert.equal(small.status, 400);
  assert.equal(small.body.error.code, 'VALIDATION_FAILED');
});

test('an intent needs a UUID Idempotency-Key', async () => {
  const { body: q } = await quote(stack.api);
  const missing = await post(stack.api, '/v1/tip-intents', {
    quoteId: q.data.quoteId,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_FAILED');
  const bad = await intent(
    stack.api,
    { quoteId: q.data.quoteId },
    'not-a-uuid',
  );
  assert.equal(bad.status, 400);
});

test('a double tap creates one tip with the same token and checkout URL', async () => {
  const { body: q } = await quote(stack.api);
  const key = randomUUID();
  const body = {
    quoteId: q.data.quoteId,
    message: 'Lovely coffee, secret-words',
  };
  const [a, b] = await Promise.all([
    intent(stack.api, body, key),
    intent(stack.api, body, key),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.data.tipId, b.body.data.tipId);
  assert.equal(a.body.data.statusToken, b.body.data.statusToken);
  assert.equal(a.body.data.checkoutUrl, b.body.data.checkoutUrl);
  assert.match(
    a.body.data.checkoutUrl,
    /^http:\/\/localhost:3000\/mock-checkout\/mock_pay_/,
  );
  assert.doesNotMatch(JSON.stringify(a.body), /secret-words/);
  const { rows } = await database.pool.query(
    `SELECT a.status, a.provider_reference FROM payment_attempts a
       JOIN tips t ON t.intent_id = a.intent_id WHERE t.id = $1`,
    [a.body.data.tipId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'INITIATED');
  assert.match(rows[0].provider_reference, /^mock_pay_/);
  assert.equal(
    a.body.data.checkoutUrl.endsWith(rows[0].provider_reference),
    true,
  );
});

test('the same key with a different body is a conflict', async () => {
  const { body: q } = await quote(stack.api);
  const key = randomUUID();
  assert.equal(
    (await intent(stack.api, { quoteId: q.data.quoteId, message: 'one' }, key))
      .status,
    201,
  );
  const second = await intent(
    stack.api,
    { quoteId: q.data.quoteId, message: 'two' },
    key,
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('expired and used quotes are refused', async () => {
  const { body: q } = await quote(stack.api);
  await database.pool.query(
    `UPDATE tip_quotes SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [q.data.quoteId],
  );
  const expired = await intent(stack.api, { quoteId: q.data.quoteId });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, 'QUOTE_EXPIRED');

  const { body: fresh } = await quote(stack.api);
  assert.equal(
    (await intent(stack.api, { quoteId: fresh.data.quoteId })).status,
    201,
  );
  const used = await intent(stack.api, { quoteId: fresh.data.quoteId });
  assert.equal(used.status, 409);
  assert.equal(used.body.error.code, 'QUOTE_ALREADY_USED');
});

test('CORS allows only the web origin', async () => {
  const preflight = (origin) =>
    fetch(`${stack.api}/v1/tip-intents`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });
  const ok = await preflight(WEB);
  assert.equal(ok.headers.get('access-control-allow-origin'), WEB);
  assert.match(
    ok.headers.get('access-control-allow-headers') ?? '',
    /idempotency-key/,
  );
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const evil = await preflight('https://evil.example');
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const health = await fetch(`${stack.api}/health/live`, {
    headers: { origin: WEB },
  });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
});

test('the 31st quote in a minute from one address is rate limited', async () => {
  const limited = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB },
  });
  try {
    // Until Redis connects the limiter fails open by design; count only once it is ready.
    const deadline = Date.now() + 5000;
    while ((await fetch(`${limited.api}/health/ready`)).status !== 200) {
      if (Date.now() > deadline) throw new Error('API never became ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A fixed window must not roll over mid-test.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 55_000)
      await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
    for (let i = 0; i < 30; i += 1)
      assert.equal((await quote(limited.api)).status, 201);
    const refused = await quote(limited.api);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  } finally {
    await limited.stop();
  }
});

const statusOf = (api, tipId, token) =>
  fetch(`${api}/v1/tips/${tipId}/status`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

test('tip status needs the tip’s own token and never shows the message', async () => {
  const { body: q } = await quote(stack.api);
  const { body: a } = await intent(stack.api, {
    quoteId: q.data.quoteId,
    message: 'hidden-note',
  });
  const { body: other } = await intent(stack.api, {
    quoteId: (await quote(stack.api)).body.data.quoteId,
  });
  const ok = await statusOf(stack.api, a.data.tipId, a.data.statusToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const text = await ok.text();
  assert.doesNotMatch(text, /hidden-note/);
  const view = JSON.parse(text).data;
  assert.equal(view.state, 'waiting');
  assert.equal(view.recipient.handle, 'ada');
  for (const token of ['wrong', undefined, other.data.statusToken]) {
    const refused = await statusOf(stack.api, a.data.tipId, token);
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).error.code, 'NOT_FOUND');
  }
  assert.equal((await statusOf(stack.api, 'not-a-uuid', 'x')).status, 404);
});

const tipFor = async (api) => {
  const { body: q } = await quote(api);
  const { body } = await intent(api, { quoteId: q.data.quoteId });
  return {
    ...body.data,
    reference: body.data.checkoutUrl.split('/mock-checkout/')[1],
  };
};
const pretend = (api, reference, outcome) =>
  post(api, `/v1/mock-provider/checkout/${reference}`, { outcome });
const stateOf = async (api, tipId, token) =>
  (await (await statusOf(api, tipId, token)).json()).data.state;

test('the pretend checkout shows what is being paid', async () => {
  const tip = await tipFor(stack.api);
  const response = await fetch(
    `${stack.api}/v1/mock-provider/checkout/${tip.reference}`,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.amountMinor, '100000');
  assert.equal(data.currency, 'NGN');
  assert.ok(data.recipientDisplayName.length > 0);
  const unknown = await fetch(
    `${stack.api}/v1/mock-provider/checkout/mock_pay_${randomUUID()}`,
  );
  assert.equal(unknown.status, 404);
  assert.equal(
    (await pretend(stack.api, `mock_pay_${randomUUID()}`, 'succeed')).status,
    404,
  );
});

test('a pretend payment that succeeds returns to a paid receipt', async () => {
  const tip = await tipFor(stack.api);
  const { status, body } = await pretend(stack.api, tip.reference, 'succeed');
  assert.equal(status, 201);
  // The reference alone never yields the receipt token: the tab that tipped already holds it.
  assert.equal(body.data.returnUrl, `${WEB}/tip/${tip.tipId}`);
  assert.equal(await stateOf(stack.api, tip.tipId, tip.statusToken), 'paid');
});

test('a declined pretend payment shows declined', async () => {
  const tip = await tipFor(stack.api);
  assert.equal(
    (await pretend(stack.api, tip.reference, 'decline')).status,
    201,
  );
  assert.equal(
    await stateOf(stack.api, tip.tipId, tip.statusToken),
    'declined',
  );
});

test('a payment the provider never reports is found by reconciliation', async () => {
  const { reconcileAttempts } =
    await import('../../packages/database/dist/index.js');
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = await import('./helpers.mjs');
  const tip = await tipFor(stack.api);
  assert.equal(
    (await pretend(stack.api, tip.reference, 'no-reply')).status,
    201,
  );
  assert.equal(await stateOf(stack.api, tip.tipId, tip.statusToken), 'waiting');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  try {
    const provider = createMockProvider({ redis, prefix: stack.prefix });
    await reconcileAttempts({
      db: database.db,
      provider,
      now: new Date(),
      minAgeMs: 0,
    });
  } finally {
    await redis.quit();
  }
  assert.equal(await stateOf(stack.api, tip.tipId, tip.statusToken), 'paid');
});

test('the outcome cannot be changed once chosen', async () => {
  const tip = await tipFor(stack.api);
  await pretend(stack.api, tip.reference, 'succeed');
  const again = await pretend(stack.api, tip.reference, 'decline');
  assert.equal(again.status, 201);
  assert.equal(await stateOf(stack.api, tip.tipId, tip.statusToken), 'paid');
  assert.equal((await pretend(stack.api, tip.reference, 'forged')).status, 400);
});

test('fix: an expired tip can no longer be paid on the pretend checkout', async () => {
  const { expireStaleTips } =
    await import('../../packages/database/dist/index.js');
  const tip = await tipFor(stack.api);
  await database.pool.query(
    `UPDATE tip_quotes SET expires_at = now() - interval '1 hour'
       WHERE id = (SELECT i.quote_id FROM payment_intents i JOIN tips t ON t.intent_id = i.id WHERE t.id = $1)`,
    [tip.tipId],
  );
  const pending = async () => ({
    status: 'pending',
    amountMinor: 0n,
    currency: 'NGN',
    feeMinor: 0n,
  });
  await expireStaleTips({
    db: database.db,
    provider: { verifyTransaction: pending },
    now: new Date(),
  });
  const summary = await fetch(
    `${stack.api}/v1/mock-provider/checkout/${tip.reference}`,
  );
  assert.equal(summary.status, 409);
  assert.equal((await summary.json()).error.code, 'TIP_NOT_PAYABLE');
  const paid = await pretend(stack.api, tip.reference, 'succeed');
  assert.equal(paid.status, 409);
  assert.equal(paid.body.error.code, 'TIP_NOT_PAYABLE');
  assert.equal(
    await stateOf(stack.api, tip.tipId, tip.statusToken),
    'cancelled',
  );
});

test('minor: replaying a tip that expired before reaching the provider is refused, not a 500', async () => {
  const { createPaymentIntent, createQuote, expireStaleTips } =
    await import('../../packages/database/dist/index.js');
  const quoted = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const key = randomUUID();
  // As if the first request crashed after creating the tip, before the provider was called.
  await createPaymentIntent(database.db, {
    quoteId: quoted.quoteId,
    idempotencyKey: key,
  });
  await database.pool.query(
    `UPDATE tip_quotes SET expires_at = now() - interval '1 hour' WHERE id = $1`,
    [quoted.quoteId],
  );
  const never = async () => {
    throw new Error(
      'the provider must not be asked about a payment it never saw',
    );
  };
  await expireStaleTips({
    db: database.db,
    provider: { verifyTransaction: never },
    now: new Date(),
  });
  const replay = await intent(stack.api, { quoteId: quoted.quoteId }, key);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'TIP_NOT_PAYABLE');
});

test('minor: behind a trusted proxy each supporter has their own rate limit', async () => {
  const proxied = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      TRUST_PROXY_HOPS: '1',
      RATE_LIMIT_QUOTES_PER_MIN: '1',
    },
  });
  try {
    const deadline = Date.now() + 5000;
    while ((await fetch(`${proxied.api}/health/ready`)).status !== 200) {
      if (Date.now() > deadline) throw new Error('API never became ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 55_000)
      await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
    const from = (ip) =>
      post(
        proxied.api,
        '/v1/tip-quotes',
        { handle: 'ada', amountMinor: '100000', currency: 'NGN' },
        { 'x-forwarded-for': ip },
      );
    assert.equal((await from('203.0.113.7')).status, 201);
    assert.equal((await from('203.0.113.7')).status, 429);
    assert.equal((await from('198.51.100.9')).status, 201);
    // One IPv6 /64 (a single household or phone) shares a bucket.
    assert.equal((await from('2001:db8:1:2::1')).status, 201);
    assert.equal((await from('2001:db8:1:2:ffff::9')).status, 429);
  } finally {
    await proxied.stop();
  }
});
