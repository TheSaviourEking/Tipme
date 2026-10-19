import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import {
  createMockProvider,
  planScenario,
  runScenario,
  verifySignature,
} from '../../dist/index.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
after(() => redis.quit());
const secret = 'test-secret-that-is-at-least-32-chars!!';
const provider = () =>
  createMockProvider({
    redis,
    secret,
    prefix: `t-${randomUUID().slice(0, 8)}`,
  });

test('payments start pending, report the mock fee, and can be resolved', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
  });
  assert.match(providerReference, /^mock_pay_/);
  assert.deepEqual(await mock.verifyTransaction(providerReference), {
    status: 'pending',
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  });
  await mock.markStatus(providerReference, 'succeeded');
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(
    (await mock.verifyTransaction('mock_pay_nope')).status,
    'not_found',
  );
});

test('a no-reply payment is captured silently', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    scenario: 'no-reply',
  });
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
});

test('scenario plans match the agreed behaviours', () => {
  const payment = {
    reference: 'mock_pay_x',
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  };
  const types = (scenario) =>
    planScenario(scenario, payment).map((step) => step.body.type);
  assert.deepEqual(types('succeed'), ['payment.pending', 'payment.succeeded']);
  assert.deepEqual(types('decline'), ['payment.failed']);
  assert.deepEqual(types('out-of-order'), [
    'payment.succeeded',
    'payment.pending',
  ]);
  const duplicate = planScenario('duplicate', payment);
  assert.equal(duplicate.length, 2);
  assert.equal(duplicate[0].body.id, duplicate[1].body.id);
  assert.equal(
    planScenario('wrong-amount', payment)[0].body.data.amountMinor,
    '99999',
  );
  assert.equal(planScenario('forged', payment)[0].signed, false);
  assert.deepEqual(planScenario('no-reply', payment), []);
  assert.ok(planScenario('pending-then-succeed', payment)[1].delayMs >= 500);
});

test('the simulator signs real deliveries and mis-signs forged ones', async (t) => {
  const received = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      received.push(
        verifySignature(
          Buffer.from(raw),
          request.headers['x-mock-signature'],
          secret,
          new Date(),
        ),
      );
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const payment = {
    reference: 'mock_pay_x',
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  };
  assert.deepEqual(
    await runScenario({
      plan: planScenario('succeed', payment),
      webhookUrl: url,
      secret,
    }),
    [200, 200],
  );
  await runScenario({
    plan: planScenario('forged', payment),
    webhookUrl: url,
    secret,
  });
  assert.deepEqual(received, ['ok', 'ok', 'bad_signature']);
});

test('the outcome can be chosen once, on the pretend checkout page', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
  });
  assert.equal(await mock.chooseScenario(providerReference, 'no-reply'), true);
  // A no-reply payment is captured silently: only the status check reveals it.
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(await mock.chooseScenario(providerReference, 'decline'), false);
  await mock.settle(providerReference);
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(await mock.chooseScenario('mock_pay_unknown', 'succeed'), false);
});
