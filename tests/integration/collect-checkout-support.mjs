import { randomUUID } from 'node:crypto';
import { CheckoutService } from '../../apps/api/dist/checkout/checkout.service.js';
import { MeProfileController } from '../../apps/api/dist/profiles/me-profile.controller.js';
import {
  beginPaymentAccountCreation,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

// You collect (plan Task 6): the checkout service with recording stand-ins for the pretend provider
// and the partner, so a test sees every provider call TipMe makes. Shared by collect-checkout.test.mjs
// and the script that captured the switch-off fixture from dev's code before Task 6 changed it.

const logger = { info() {}, warn() {}, error() {} };
export const WEB_ORIGIN = 'http://127.0.0.1:3000';

/** A stand-in that records each call's arguments and answers like the provider would. */
export function recordingProviders({ collectError } = {}) {
  const calls = [];
  let n = 0;
  const bachs = {
    environment: 'sandbox',
    name: 'bachs',
    async initializePayment(input) {
      calls.push(['bachs.initializePayment', input]);
      n += 1;
      return {
        providerReference: `${input.recipientAccountReference}:cs_${n}`,
        checkoutUrl: `https://checkout.bachs.test/cs_${n}`,
      };
    },
    async initializeCollectCheckout(input) {
      calls.push(['bachs.initializeCollectCheckout', input]);
      if (collectError) throw collectError;
      n += 1;
      return {
        providerReference: `platform:cs_${n}`,
        checkoutUrl: `https://checkout.bachs.test/cs_${n}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },
    async getCheckoutUrl(reference) {
      calls.push(['bachs.getCheckoutUrl', reference]);
      return `https://checkout.bachs.test/${reference.split(':').at(-1)}`;
    },
  };
  const mock = {
    name: 'mock',
    async initializePayment(input) {
      calls.push(['mock.initializePayment', input]);
      n += 1;
      return { providerReference: `mock_pay_${n}` };
    },
    async initializeCollectCheckout(input) {
      calls.push(['mock.initializeCollectCheckout', input]);
      n += 1;
      return {
        providerReference: `platform:mock_collect_${n}`,
        checkoutUrl: `/mock-checkout/platform:mock_collect_${n}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },
  };
  return { calls, bachs, mock };
}

/** Checkout on the partner (`bachs`) and on the pretend provider (`mock`), sharing one recording. */
export function services(db, providers) {
  const config = {
    WEB_ORIGIN,
    STATUS_TOKEN_SECRET: 'test-only-status-token-secret-32-characters',
  };
  return {
    bachs: new CheckoutService(
      config,
      { db },
      { name: 'bachs' },
      providers.mock,
      providers.bachs,
      logger,
    ),
    mock: new CheckoutService(
      config,
      { db },
      { name: 'mock' },
      providers.mock,
      null,
      logger,
    ),
  };
}

/** The sign-up route (POST /v1/me/page) with its side effects stubbed. */
export function signUpRoute(db) {
  return new MeProfileController(
    { RELEASE_KIND: 'production' },
    { db },
    null,
    { async record() {} },
    null,
    async () => {},
  );
}

/** A user with no page yet. */
export async function newUser(pool) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, phone_e164) VALUES ($1, $2)`, [
    id,
    `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  ]);
  return id;
}

/** The demo pages; Ada has an ACTIVE partner account, Tobi has none. */
export async function seedPages(database) {
  await database.reset();
  await seedDemoProfiles(database.db);
  await beginPaymentAccountCreation(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_ada123',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
}

const outcome = async (work) => {
  try {
    return { ok: await work() };
  } catch (error) {
    return {
      error: error.code ?? error.name,
      ...(typeof error.getStatus === 'function'
        ? { status: error.getStatus() }
        : {}),
    };
  }
};

const QUOTE = (handle) => ({ handle, amountMinor: '200000', currency: 'NGN' });

/**
 * Today's quotes, checkouts and sign-ups with the switch off: every answer, every provider call
 * and the collection modes stored. Ids and times are replaced by placeholders (normalise).
 * `afterSeed` runs once the pages are seeded (the switch-off rerun turns the switch off there).
 */
export async function switchOffTranscript(database, { afterSeed } = {}) {
  await seedPages(database);
  await afterSeed?.();
  const providers = recordingProviders();
  const checkout = services(database.db, providers);
  const steps = [];
  const quotes = [];
  const step = async (name, work) => {
    const result = await outcome(work);
    if (result.ok?.quoteId) quotes.push(result.ok.quoteId);
    steps.push([name, result, providers.calls.splice(0)]);
    return result.ok;
  };

  // The partner: Ada's own account, then a page with none.
  const ada = await step('bachs quote ada', () =>
    checkout.bachs.quote(QUOTE('ada')),
  );
  const key = randomUUID();
  await step('bachs intent ada', () =>
    checkout.bachs.createIntent({ quoteId: ada.quoteId }, key),
  );
  await step('bachs intent ada, replayed', () =>
    checkout.bachs.createIntent({ quoteId: ada.quoteId }, key),
  );
  const tobi = await step('bachs quote tobi', () =>
    checkout.bachs.quote(QUOTE('tobi')),
  );
  await step('bachs intent tobi', () =>
    checkout.bachs.createIntent({ quoteId: tobi.quoteId }, randomUUID()),
  );
  // The pretend provider.
  const mockAda = await step('mock quote ada', () =>
    checkout.mock.quote(QUOTE('ada')),
  );
  await step('mock intent ada', () =>
    checkout.mock.createIntent({ quoteId: mockAda.quoteId }, randomUUID()),
  );
  // A sign-up, live, tipped on both.
  const userId = await newUser(database.pool);
  await step('sign-up', async () => {
    await signUpRoute(database.db).claim(
      { userId },
      { handle: 'newcomer' },
      undefined,
    );
    return { signedUp: true };
  });
  await database.pool.query(
    `UPDATE profiles SET page_state = 'live' WHERE user_id = $1`,
    [userId],
  );
  const fresh = await step('bachs quote newcomer', () =>
    checkout.bachs.quote(QUOTE('newcomer')),
  );
  await step('bachs intent newcomer', () =>
    checkout.bachs.createIntent({ quoteId: fresh.quoteId }, randomUUID()),
  );
  const freshMock = await step('mock quote newcomer', () =>
    checkout.mock.quote(QUOTE('newcomer')),
  );
  await step('mock intent newcomer', () =>
    checkout.mock.createIntent({ quoteId: freshMock.quoteId }, randomUUID()),
  );

  const stored = {
    profiles: (
      await database.pool.query(
        `SELECT handle, collection_mode FROM profiles ORDER BY handle`,
      )
    ).rows,
    quotes: [],
    attempts: (
      await database.pool.query(
        `SELECT a.status, a.provider, a.provider_reference, q.collection_mode
           FROM payment_attempts a
           JOIN payment_intents i ON i.id = a.intent_id
           JOIN tip_quotes q ON q.id = i.quote_id
          ORDER BY a.provider_reference`,
      )
    ).rows,
  };
  for (const id of quotes)
    stored.quotes.push(
      (
        await database.pool.query(
          `SELECT collection_mode, payer_total_minor::text, platform_fee_minor::text
             FROM tip_quotes WHERE id = $1`,
          [id],
        )
      ).rows[0],
    );
  return normalise({ steps, stored });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
// A status token is a signature over the tip id: its shape, not its bytes, is today's.
const TOKEN = /"statusToken":"[A-Za-z0-9_-]+"/g;

/** JSON with bigints as strings, each distinct id as <id:n> by first appearance, times as <time>. */
export function normalise(value) {
  const ids = new Map();
  const text = JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? `${v}n` : v instanceof Date ? 'date' : v,
  )
    .replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
      return ids.get(id);
    })
    .replace(ISO, '<time>')
    .replace(TOKEN, '"statusToken":"<token>"');
  return JSON.parse(text);
}
