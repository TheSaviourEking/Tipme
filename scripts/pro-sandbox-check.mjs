#!/usr/bin/env node
// Paid Pro (ADR-0015): a MANUAL, opt-in check that TipMe's own adapter code opens a ₦2,500 checkout
// on TipMe's own partner account in the SANDBOX. Never run by CI or `pnpm test` (it isn't a test
// file). Test money only: it talks to https://sandbox-api.bachs.io with an `sk_sandbox_` key and
// refuses anything else. It prints the checkout's id, status, URL and expiry, never the key.
//
//   pnpm --filter @tipme/payments build
//   node --env-file-if-exists=.env scripts/pro-sandbox-check.mjs --sandbox
//
// The checkout it opens expires unpaid after about 30 minutes; nothing is charged unless someone
// pays it with the partner's test card.
import { randomUUID } from 'node:crypto';

const SANDBOX_ORIGIN = 'https://sandbox-api.bachs.io';

function refuse(message) {
  console.error(`pro-sandbox-check: ${message}`);
  process.exit(2);
}

if (!process.argv.includes('--sandbox'))
  refuse('opt-in only: pass --sandbox to open one ₦2,500 sandbox checkout.');
const key = process.env.BACHS_SANDBOX_API_KEY ?? '';
if (!key.startsWith('sk_sandbox_'))
  refuse('BACHS_SANDBOX_API_KEY must be set to an sk_sandbox_ key.');

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
  apiKey: key,
  environment: 'sandbox',
  fetchImpl: sandboxOnly,
});

const purchaseId = randomUUID();
const settings = 'https://usetipme.xyz/dashboard/settings#plan';
try {
  const created = await provider.initializePlatformCheckout({
    purchaseId,
    amountMinor: 250_000n,
    currency: 'NGN',
    successUrl: settings,
    cancelUrl: settings,
    idempotencyKey: `tipme-pro-${purchaseId}`,
  });
  const read = await provider.verifyTransaction(created.providerReference);
  console.log(
    JSON.stringify(
      {
        environment: 'sandbox',
        purchaseId,
        providerReference: created.providerReference,
        checkoutId: created.providerReference.slice('platform:'.length),
        // initializePlatformCheckout only returns for a checkout the partner made `open`.
        createdStatus: 'open',
        checkoutUrl: created.checkoutUrl,
        expiresAt: created.expiresAt.toISOString(),
        readBack: {
          status: read.status,
          amountMinor: String(read.amountMinor),
          currency: read.currency,
        },
      },
      null,
      2,
    ),
  );
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
