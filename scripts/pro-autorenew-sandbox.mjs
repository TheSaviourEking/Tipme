#!/usr/bin/env node
// Paid Pro auto-renew (plan Task 10; ruling 9): a MANUAL, opt-in sandbox proof that a naira card
// saved on a ₦2,500 checkout on TipMe's own partner account can be charged off-session. Never run by
// CI or `pnpm test` (it isn't a test file). Test money only: it talks to
// https://sandbox-api.bachs.io with an `sk_sandbox_` key and refuses anything else. It prints ids,
// statuses and URLs, never the key. Evidence E8 to E10 in .superpowers/program/pro-billing-readiness.md.
//
// Paying a checkout needs the partner's test card in a browser, so this runs in three steps, by a
// person (the owner or staff with sandbox access), not an agent:
//
//   pnpm --filter @tipme/payments build
//
//   1. Open a saving checkout (makes a customer, then a ₦2,500 checkout with save_payment_method):
//        node --env-file-if-exists=.env scripts/pro-autorenew-sandbox.mjs --sandbox --step=checkout \
//          --email=you@example.com
//      Open the printed checkoutUrl in a browser and pay with the partner's test card (4242…).
//      Then find `payment_method.saved` for the printed customer in the partner dashboard's webhook
//      log (or the endpoint's deliveries) and note its `data.payment_method_id` (pm_…). E8.
//
//   2. Charge the saved card off-session, ₦2,500 (no customer action):
//        node --env-file-if-exists=.env scripts/pro-autorenew-sandbox.mjs --sandbox --step=charge \
//          --customer=cust_… --payment-method=pm_…
//      It charges once, then repeats the same request with the same Idempotency-Key, and prints both
//      answers: the same charge id twice proves a lost answer can be asked again safely. E9.
//
//   3. Read the charge back until it is no longer `pending`:
//        node --env-file-if-exists=.env scripts/pro-autorenew-sandbox.mjs --sandbox --step=read \
//          --charge=ch_…
//      `succeeded` with a fee: E9 done. For E10, repeat steps 1 to 3 paying with 4000 0000 0000 0341:
//      the charge must come back `failed` (and `collection.failed` arrive).
//
// Record each result in docs/evidence/ with the date, request ids and redacted ids.
import { randomUUID } from 'node:crypto';

const SANDBOX_ORIGIN = 'https://sandbox-api.bachs.io';

function refuse(message) {
  console.error(`pro-autorenew-sandbox: ${message}`);
  process.exit(2);
}
const arg = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

if (!process.argv.includes('--sandbox'))
  refuse('opt-in only: pass --sandbox (test money, sandbox only).');
const sandboxApiCredential = process.env.BACHS_SANDBOX_API_KEY ?? '';
if (!sandboxApiCredential.startsWith('sk_sandbox_'))
  refuse('BACHS_SANDBOX_API_KEY must be set to an sk_sandbox_ key.');
const step = arg('step');
if (!['checkout', 'charge', 'read'].includes(step ?? ''))
  refuse('pass --step=checkout, --step=charge or --step=read.');

const { createBachsProvider } = await import(
  new URL('../packages/payments/dist/index.js', import.meta.url).href
);

/** Every request goes to the sandbox origin, or not at all. */
const sandboxOnly = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== SANDBOX_ORIGIN)
    return Promise.reject(
      new Error(`refused: ${url.origin} is not the sandbox`),
    );
  return fetch(input, init);
};

const provider = createBachsProvider({
  apiKey: sandboxApiCredential,
  environment: 'sandbox',
  fetchImpl: sandboxOnly,
});
const print = (value) =>
  console.log(
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2),
  );

try {
  if (step === 'checkout') {
    const email = arg('email');
    if (!email || !email.includes('@'))
      refuse('pass --email=<a test address>.');
    const purchaseId = randomUUID();
    const { customerReference } = await provider.createPlatformCustomer({
      email,
      name: 'TipMe sandbox auto-renew check',
      idempotencyKey: `tipme-pro-customer-${purchaseId}`,
    });
    const settings = 'https://usetipme.xyz/dashboard/settings#plan';
    const created = await provider.initializePlatformCheckout({
      purchaseId,
      amountMinor: 250_000n,
      currency: 'NGN',
      successUrl: settings,
      cancelUrl: settings,
      idempotencyKey: `tipme-pro-${purchaseId}`,
      saveCard: { customerReference },
    });
    print({
      environment: 'sandbox',
      step,
      purchaseId,
      customerReference,
      providerReference: created.providerReference,
      checkoutUrl: created.checkoutUrl,
      expiresAt: created.expiresAt.toISOString(),
      next: 'Pay it with the test card in a browser, then note payment_method.saved’s pm_ id.',
    });
  } else if (step === 'charge') {
    const customerReference = arg('customer');
    const paymentMethodReference = arg('payment-method');
    if (!customerReference?.startsWith('cust_'))
      refuse('pass --customer=cust_…');
    if (!paymentMethodReference?.startsWith('pm_'))
      refuse('pass --payment-method=pm_…');
    const purchaseId = randomUUID();
    const input = {
      customerReference,
      paymentMethodReference,
      amountMinor: 250_000n,
      currency: 'NGN',
      reference: purchaseId,
      idempotencyKey: `tipme-pro-${purchaseId}`,
    };
    const first = await provider.chargeSavedCard(input);
    // The same key again: the partner should answer with the same charge (a safe re-ask).
    const again = await provider.chargeSavedCard(input);
    print({
      environment: 'sandbox',
      step,
      purchaseId,
      first,
      again,
      sameCharge: first.providerReference === again.providerReference,
      next: `Read it back: --step=read --charge=${first.providerReference.slice('platform-charge:'.length)}`,
    });
  } else {
    const charge = arg('charge');
    if (!charge?.startsWith('ch_')) refuse('pass --charge=ch_…');
    const read = await provider.verifyTransaction(`platform-charge:${charge}`);
    print({ environment: 'sandbox', step, charge, read });
  }
} catch (error) {
  // Names and partner codes only: never the request, the key or the partner's message text.
  console.error(
    JSON.stringify({
      error: error?.name ?? 'Error',
      ...(error?.providerCode ? { providerCode: error.providerCode } : {}),
      ...(error?.statusCode ? { statusCode: error.statusCode } : {}),
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
    }),
  );
  process.exit(1);
}
