#!/usr/bin/env node
// Plays a mock-provider scenario against the local API and prints the tip's proof.
// Usage: pnpm mock:pay --scenario <name> [--handle ada] [--amount 1000.00] [--api http://127.0.0.1:4000]
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import {
  DEMO_PROFILES,
  assertLocalDatabaseUrl,
  createDatabase,
  createPaymentIntent,
  createPayout,
  createQuote,
  markAttemptInitiated,
  markPayoutInitiated,
  tipProof,
} from '../packages/database/dist/index.js';
import {
  SCENARIOS,
  createMockProvider,
  planPayoutScenario,
  planScenario,
  runScenario,
} from '../packages/payments/dist/index.js';

const { Redis } = createRequire(
  new URL('../packages/payments/package.json', import.meta.url),
)('ioredis');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    handle: { type: 'string', default: 'ada' },
    amount: { type: 'string', default: '1000.00' },
    api: { type: 'string', default: 'http://127.0.0.1:4000' },
  },
});
if (!SCENARIOS.includes(values.scenario))
  fail(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is not set (copy .env.example to .env).');
try {
  assertLocalDatabaseUrl(databaseUrl);
} catch (error) {
  fail(error.message);
}
// Signed webhooks and pretend provider state stay on this machine.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLocal = (url) => {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};
if (!isLocal(values.api))
  fail('--api must be a local address (localhost, 127.0.0.1 or ::1).');
if (!isLocal(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'))
  fail('Refusing to use a non-local Redis.');
const secret = process.env.MOCK_PROVIDER_WEBHOOK_SECRET;
if (!secret || secret.length < 32)
  fail(
    'MOCK_PROVIDER_WEBHOOK_SECRET (>= 32 chars) is not set; see .env.example.',
  );
const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(values.amount);
if (!match) fail('--amount must look like 1000 or 1000.50');
const amountMinor =
  BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));

const database = createDatabase(databaseUrl, { max: 2 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
// Same namespace as the local API and worker, so reconciliation sees these pretend payments.
const mock = createMockProvider({
  redis,
  secret,
  prefix: process.env.QUEUE_PREFIX ?? 'tipme',
});
const webhookUrl = `${values.api}/v1/webhooks/mock`;
const send = (plan) =>
  runScenario({ plan, webhookUrl, secret }).catch(() =>
    fail(`API not reachable at ${values.api}. Start it with \`pnpm dev\`.`),
  );

async function playPayment(scenario) {
  const quote = await createQuote(database.db, {
    handle: values.handle,
    tipMinor: amountMinor,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: crypto.randomUUID(),
  });
  const { providerReference } = await mock.initializePayment({
    attemptId,
    amountMinor,
    currency: 'NGN',
    scenario,
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference,
  });
  const payment = {
    reference: providerReference,
    attemptId,
    amountMinor,
    currency: 'NGN',
    feeMinor: quote.breakdown.providerFeeMinor,
  };
  const statuses = await send(planScenario(scenario, payment));
  await mock.settle(providerReference);
  console.log(
    `Webhooks sent: ${statuses.length ? statuses.join(', ') : 'none (the provider stays silent)'}`,
  );
  if (scenario === 'no-reply') {
    console.log(
      'The background check will ask the provider once the attempt is old enough (RECONCILE_MIN_AGE_MS, default 2 min).',
    );
  }
  return tipId;
}

async function playPayout(scenario) {
  const profile = DEMO_PROFILES.find((entry) => entry.handle === values.handle);
  if (!profile)
    fail(
      `Payouts are only scripted for demo profiles: ${DEMO_PROFILES.map((entry) => entry.handle).join(', ')}`,
    );
  const { rows } = await database.pool.query(
    `SELECT t.id FROM tips t
      WHERE t.profile_id = $1 AND t.status = 'SUCCEEDED'
        AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.tip_id = t.id AND i.active)
      ORDER BY t.created_at`,
    [profile.id],
  );
  if (rows.length === 0)
    fail(
      `No unpaid succeeded tips for ${values.handle}. Run \`pnpm mock:pay --scenario succeed\` first.`,
    );
  const payout = await createPayout(database.db, {
    profileId: profile.id,
    tipIds: rows.map((row) => row.id),
    idempotencyKey: crypto.randomUUID(),
  });
  const { providerReference } = await mock.initiatePayout({
    ...payout,
    idempotencyKey: payout.payoutId,
    scenario,
  });
  await markPayoutInitiated(database.db, {
    payoutId: payout.payoutId,
    provider: 'mock',
    providerReference,
  });
  const statuses = await send(
    planPayoutScenario(scenario, { reference: providerReference, ...payout }),
  );
  await mock.settlePayout(providerReference);
  console.log(
    `Payout webhooks sent: ${statuses.join(', ')} (${rows.length} tip(s), ${payout.amountMinor} minor units)`,
  );
  return rows[0].id;
}

try {
  const scenario = values.scenario;
  const tipId = scenario.startsWith('payout-')
    ? await playPayout(scenario)
    : await playPayment(scenario);
  const proof = await tipProof(database.db, tipId);
  console.log(`Tip ${tipId}: ${proof.tip.status}`);
  if (proof.payment)
    console.log(
      `  Payment confirmed by provider event ${proof.payment.providerEventId} (ref ${proof.payment.providerReference})`,
    );
  if (proof.payout)
    console.log(
      `  Payout ${proof.payout.status} (ref ${proof.payout.providerReference ?? 'none yet'})`,
    );
  console.log('Trace: http://127.0.0.1:16686/search?service=tipme-api');
} finally {
  await redis.quit().catch(() => undefined);
  await database.close();
}
