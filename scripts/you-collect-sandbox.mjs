#!/usr/bin/env node
// You collect (ADR-0016, PROPOSED; plan Task 16, spec §12.3): a MANUAL, opt-in check of TipMe's own
// adapter code against the payment partner's SANDBOX, before the owner turns the switch on anywhere.
// Never run by CI or `pnpm test` (it isn't a test file). Test money only: it talks to
// https://sandbox-api.bachs.io with an `sk_sandbox_` key and refuses anything else. It prints ids,
// statuses and PASS / FAIL / NEEDS-HUMAN lines, never the key, a name or an account number.
//
// Paying a checkout needs the partner's test card in a browser, so this runs in steps, by a person
// (the owner or staff with sandbox access), not an agent:
//
//   pnpm --filter @tipme/payments build
//
//   1. A person's receive-only account, two name writes, the same bank account added twice, and two
//      collect checkouts (one with the supporter's name and an email prefilled):
//        node --env-file-if-exists=.env scripts/you-collect-sandbox.mjs --sandbox --step=start \
//          --bank-code=<a sandbox test bank code> --account-number=<its test account number>
//      Pay the first printed checkoutUrl with the partner's test card. Open the second (the prefill
//      check, e): say whether the name and email show filled in, and whether you can edit them.
//
//   2. Once the first checkout is paid: read the payment, transfer from TipMe's balance to the
//      account, replay the same key, list the account's transfers, read TipMe's balances and
//      payout schedule:
//        node --env-file-if-exists=.env scripts/you-collect-sandbox.mjs --sandbox --step=transfer \
//          --account=<acct id from step 1> --checkout=<platform:… from step 1>
//
//   3. Dispute evidence with one file, on a sandbox dispute of a TipMe-account payment (opened with
//      the partner's dispute test card, if the sandbox has one):
//        node --env-file-if-exists=.env scripts/you-collect-sandbox.mjs --sandbox --step=evidence \
//          --dispute=<dispute id>
//
// Paste each step's output into the PR (or docs/evidence/) with the date. The sandbox cannot prove
// what the end of each step lists (§12.3): those are answered only by the partner in writing and a
// careful live start.
import { createHash, randomUUID } from 'node:crypto';

const SANDBOX_ORIGIN = 'https://sandbox-api.bachs.io';
const NAME = 'you-collect-sandbox';

function refuse(message) {
  console.error(`${NAME}: ${message}`);
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
if (/[\r\n]/.test(sandboxApiCredential))
  refuse('BACHS_SANDBOX_API_KEY must be one line.');
const step = arg('step');
if (!['start', 'transfer', 'evidence'].includes(step ?? ''))
  refuse('pass --step=start, --step=transfer or --step=evidence.');

const { createBachsProvider, minorToDecimal } = await import(
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

/**
 * A read or write the adapter has no method for (the account's persons, the destinations list, a
 * checkout with a customer): the adapter's own headers, through the same sandbox-only fetch. Its
 * answer is parsed here and only ids, counts, statuses and key names are ever printed.
 */
async function raw(method, path, { accountRef, idempotencyKey, body } = {}) {
  const headers = {
    authorization: `Bearer ${sandboxApiCredential}`,
    accept: 'application/json',
    'User-Agent': 'TipMe/1.0 (+https://usetipme.xyz)',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accountRef) headers['X-Account-Id'] = accountRef;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await sandboxOnly(new URL(path, SANDBOX_ORIGIN), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // Not JSON: only the status is reported.
  }
  // The partner's envelope, when there is one.
  const data =
    parsed && typeof parsed === 'object' && 'data' in parsed
      ? parsed.data
      : parsed;
  return { status: response.status, data };
}

const print = (value) =>
  console.log(
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2),
  );
const results = [];
/** One check's verdict: PASS, FAIL or NEEDS-HUMAN, with what was seen. */
function verdict(check, outcome, seen) {
  results.push({ check, outcome, seen });
  console.log(`${outcome.padEnd(11)} ${check}: ${seen}`);
}
/** Names and partner codes only: never the request, the key or the partner's message text. */
const failure = (error) => ({
  error: error?.name ?? 'Error',
  ...(error?.providerCode ? { providerCode: error.providerCode } : {}),
  ...(error?.statusCode ? { statusCode: error.statusCode } : {}),
  ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
});
const digest = (text) => createHash('sha256').update(text).digest('hex');
const keysOf = (value) =>
  value && typeof value === 'object' ? Object.keys(value).sort() : [];

// Test data only, never a real person: printed by neither name nor number.
const FIRST_NAME = { first: 'Sandbox', last: 'Recipient' };
const SECOND_NAME = { first: 'Sandbox', last: 'Renamed' };
const TIP_MINOR = 100_000n; // ₦1,000, test money.
const TRANSFER_MINOR = 10_000n; // ₦100 of it, test money.
const RETURN_URL = 'https://usetipme.xyz/tip/sandbox';

const CANNOT_PROVE = [
  'verification timing (the sandbox grants capabilities at once)',
  "the bank-name check (no /connect/requirements name match in the sandbox, so 'some words match' manual review and a refused name are never seen)",
  'manual review time (P6)',
  'live settlement: when naira card money is available to transfer (P7)',
  'dispute fees: which balance and currency the $15 is taken from, and whether it can freeze naira transfers (P5)',
  'that TipMe holding recipients’ shares is covered by the partner’s licence (P1): only the partner’s written answer',
];

async function stepStart() {
  const bankCode = arg('bank-code');
  const accountNumber = arg('account-number');
  const run = randomUUID();

  // 1. A person's receive-only account (Task 4), named on create.
  const created = await provider.createReceiveOnlyPersonAccount({
    contactEmail: `sandbox+${run.slice(0, 8)}@usetipme.xyz`,
    country: 'NG',
    legalName: FIRST_NAME,
    idempotencyKey: `tipme-person-${run}`,
  });
  const account = created.accountReference;
  print({
    step: 'person account',
    account,
    active: created.active,
    holdsLocalCurrency: created.holdsLocalCurrency,
    requirementsDue: created.requirementsDue,
  });
  const held = await provider.holdLocalCurrency(account);
  print({ step: 'hold naira', holdsLocalCurrency: held.holdsLocalCurrency });

  // b. A second name write (Task 13's correction, a new key): does it replace the person?
  try {
    await provider.nameReceiveOnlyPerson({
      accountReference: account,
      legalName: SECOND_NAME,
      idempotencyKey: `tipme-person-${run}.rename`,
    });
    const read = await raw(
      'GET',
      `/v1/accounts/${encodeURIComponent(account)}`,
    );
    const persons =
      read.data?.persons ??
      read.data?.individual?.persons ??
      read.data?.fields?.persons;
    if (!Array.isArray(persons))
      verdict(
        'b. a name write replaces the person',
        'NEEDS-HUMAN',
        `the account read (HTTP ${read.status}) shows no persons list; its fields: ${keysOf(read.data).join(', ')}. Check the account's persons in the partner dashboard: one person, named "Sandbox Renamed", is PASS`,
      );
    else {
      const last = persons.map((p) => p?.last_name ?? p?.name?.last ?? null);
      const renamed = last.filter((name) => name === SECOND_NAME.last).length;
      verdict(
        'b. a name write replaces the person',
        persons.length === 1 && renamed === 1 ? 'PASS' : 'FAIL',
        `${persons.length} person(s) after two name writes; ${renamed} carry the second name`,
      );
    }
  } catch (error) {
    verdict(
      'b. a name write replaces the person',
      'FAIL',
      JSON.stringify(failure(error)),
    );
  }

  // c. The same account number added twice under this account, each under its own name's key.
  if (!bankCode || !accountNumber)
    verdict(
      'c. the same account number twice, different name keys',
      'NEEDS-HUMAN',
      'pass --bank-code and --account-number (a sandbox test bank account) to run it',
    );
  else
    try {
      const resolved = await provider.resolveBankAccount({
        bankCode,
        accountNumber,
      });
      print({ step: 'bank lookup', resolved: resolved !== null });
      const add = (name) =>
        provider.addPayoutDestination(account, {
          bankCode,
          accountNumber,
          accountName: resolved?.accountName ?? 'Sandbox Recipient',
          nameDigest: digest(`${name.first} ${name.last}`),
        });
      const first = await add(FIRST_NAME);
      const second = await add(SECOND_NAME);
      const listed = await raw('GET', '/v1/payouts/destinations', {
        accountRef: account,
      });
      const items = Array.isArray(listed.data)
        ? listed.data
        : (listed.data?.items ?? listed.data?.data ?? null);
      print({
        step: 'destinations',
        first: { id: first.destinationRef, status: first.status },
        second: { id: second.destinationRef, status: second.status },
        listedCount: Array.isArray(items) ? items.length : null,
      });
      verdict(
        'c. the same account number twice, different name keys',
        first.destinationRef === second.destinationRef ? 'FAIL' : 'PASS',
        first.destinationRef === second.destinationRef
          ? 'the partner returned the existing destination (dedupe by number): a re-add under a corrected name always answers BANK_RECHECK_LATER, so Task 13 and Task 15’s name-recheck re-add need a change before the switch is turned on'
          : 'the partner made a second destination: a corrected name gets a fresh check (what Task 13’s BANK_RECHECK_LATER and Task 15’s re-add assume)',
      );
    } catch (error) {
      verdict(
        'c. the same account number twice, different name keys',
        'FAIL',
        JSON.stringify(failure(error)),
      );
    }

  // 2. A collect checkout on TipMe's own account, for a person to pay with the test card.
  const attemptId = randomUUID();
  const checkout = await provider.initializeCollectCheckout({
    attemptId,
    amountMinor: TIP_MINOR,
    currency: 'NGN',
    successUrl: RETURN_URL,
    cancelUrl: RETURN_URL,
    idempotencyKey: `tipme-checkout-${attemptId}`,
  });
  print({
    step: 'collect checkout (pay this one with the test card)',
    attemptId,
    providerReference: checkout.providerReference,
    checkoutUrl: checkout.checkoutUrl,
    expiresAt: checkout.expiresAt.toISOString(),
  });

  // e. Owner, 22 Nov 2026: the same checkout with `customer: { email, name }`. Not built in TipMe:
  //    only if this page shows the supporter's typed name prefilled would TipMe send it, and then
  //    the name only (never an email, never on a recipient's own account).
  const prefillId = randomUUID();
  const prefill = await raw('POST', '/v1/checkout-sessions', {
    idempotencyKey: `tipme-checkout-${prefillId}`,
    body: {
      pricing: { amount: minorToDecimal(TIP_MINOR, 'NGN'), currency: 'NGN' },
      reference: prefillId,
      success_url: RETURN_URL,
      cancel_url: RETURN_URL,
      customer_creation: 'if_required',
      payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
      customer_bears_fee: false,
      expires_in_minutes: 30,
      customer: {
        email: `sandbox+prefill${prefillId.slice(0, 8)}@usetipme.xyz`,
        name: 'Sandbox Supporter',
      },
    },
  });
  if (
    prefill.status >= 200 &&
    prefill.status < 300 &&
    prefill.data?.checkout_url
  ) {
    print({
      step: 'prefill checkout (open it; do not pay)',
      status: prefill.data.status ?? null,
      checkoutId: prefill.data.checkout_id ?? null,
      checkoutUrl: prefill.data.checkout_url,
    });
    verdict(
      'e. checkout name prefill',
      'NEEDS-HUMAN',
      'open the prefill checkoutUrl: report whether "Sandbox Supporter" and the email show filled in, and whether you can edit them',
    );
  } else
    verdict(
      'e. checkout name prefill',
      'FAIL',
      `the partner refused a checkout with a customer (HTTP ${prefill.status}): TipMe keeps sending none`,
    );

  print({
    next: `pay the first checkout, then run --step=transfer --account=${account} --checkout=${checkout.providerReference}`,
  });
}

async function stepTransfer() {
  const account = arg('account');
  const checkout = arg('checkout');
  if (!account || !/^[A-Za-z0-9_-]{1,100}$/.test(account))
    refuse('pass --account=<the acct id step 1 printed>.');
  if (!checkout || !/^platform:[A-Za-z0-9_-]{1,100}$/.test(checkout))
    refuse('pass --checkout=<the platform:… reference step 1 printed>.');

  // Read the payment, as the webhook and reconciliation do (Task 7).
  const payment = await provider.verifyTransaction(checkout);
  print({
    step: 'payment',
    status: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    feeMinor: payment.feeMinor ?? null,
    feePaidBy: payment.feePaidBy ?? null,
    method: payment.method ?? null,
  });
  if (payment.status !== 'succeeded')
    refuse('the checkout is not paid yet: pay it with the test card first.');

  // The transfer from TipMe's balance (Task 8), then the same key again.
  const key = `tipme-collect-sandbox-${randomUUID()}`;
  const send = () =>
    provider.sendCollectTransfer({
      accountRef: account,
      amountMinor: TRANSFER_MINOR,
      currency: 'NGN',
      idempotencyKey: key,
    });
  const sent = await send();
  print({
    step: 'transfer',
    transferRef: sent.transferRef,
    status: sent.status,
  });
  try {
    const replayed = await send();
    print({
      step: 'transfer, same key',
      transferRef: replayed.transferRef,
      status: replayed.status,
    });
    verdict(
      'the same key replays the transfer',
      replayed.transferRef === sent.transferRef ? 'PASS' : 'FAIL',
      replayed.transferRef === sent.transferRef
        ? 'one transfer for one key'
        : 'a second transfer id for the same key',
    );
  } catch (error) {
    verdict(
      'the same key replays the transfer',
      'FAIL',
      JSON.stringify(failure(error)),
    );
  }

  // a. The list carries `transfer_group` on each item (Task 8's read-back, P17).
  const firstPage = await raw(
    'GET',
    `/v1/transfers?connected_account_id=${encodeURIComponent(account)}&limit=100`,
  );
  print({
    step: 'transfer list shape (first page)',
    httpStatus: firstPage.status,
    fields: keysOf(firstPage.data),
    pagination: keysOf(firstPage.data?.pagination),
  });
  try {
    const listed = await provider.listAccountTransfers(account);
    const ours = listed.find((t) => t.transferRef === sent.transferRef);
    print({
      step: 'transfer list',
      count: listed.length,
      withGroup: listed.filter((t) => t.group !== null).length,
      ours: ours ? { group: ours.group, status: ours.status } : null,
    });
    verdict(
      'a. the transfer list returns transfer_group on each item',
      !ours
        ? 'NEEDS-HUMAN'
        : ours.group === key && listed.every((t) => t.group !== null)
          ? 'PASS'
          : 'FAIL',
      !ours
        ? 'our transfer is not listed yet: run this step again in a minute'
        : `ours listed with ${ours.group === key ? 'its key as transfer_group' : 'no or another transfer_group'}; ${listed.filter((t) => t.group === null).length} item(s) without one`,
    );
  } catch (error) {
    verdict(
      'a. the transfer list returns transfer_group on each item',
      'FAIL',
      JSON.stringify(failure(error)),
    );
  }

  // TipMe's own balances (every currency, signed) and payout schedule (Task 11).
  const balances = await provider.platformBalances();
  print({ step: 'platform balances', balances });
  const schedule = await provider.platformPayoutSchedule();
  print({ step: 'platform payout schedule', schedule });
  verdict(
    'automatic payouts on TipMe’s own balance are off',
    schedule.NGN === 'manual' ? 'PASS' : 'FAIL',
    `NGN interval: ${schedule.NGN ?? 'none'}`,
  );
}

async function stepEvidence() {
  const dispute = arg('dispute');
  if (!dispute) {
    verdict(
      'd. dispute evidence with one file is accepted',
      'NEEDS-HUMAN',
      'no sandbox dispute given: open one on a TipMe-account payment (the partner’s dispute test card, or ask the partner), then pass --dispute=<id>',
    );
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(dispute))
    refuse('pass --dispute=<the dispute id>.');
  // A 1×1 PNG: the smallest file the partner's upload takes.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  try {
    const { fileRef } = await provider.uploadDisputeFile({
      partnerDisputeId: dispute,
      bytes: png,
      contentType: 'image/png',
    });
    print({ step: 'evidence file', fileRef });
    const submitted = await provider.submitDisputeEvidence({
      partnerDisputeId: dispute,
      text: 'Sandbox check: TipMe evidence with one file.',
      fileRefs: [fileRef],
      idempotencyKey: `tipme-dispute-evidence-${randomUUID()}`,
    });
    verdict(
      'd. dispute evidence with one file is accepted',
      submitted.state === 'submitted' ? 'PASS' : 'FAIL',
      `state: ${submitted.state}`,
    );
  } catch (error) {
    verdict(
      'd. dispute evidence with one file is accepted',
      'FAIL',
      JSON.stringify(failure(error)),
    );
  }
}

try {
  if (step === 'start') await stepStart();
  else if (step === 'transfer') await stepTransfer();
  else await stepEvidence();
} catch (error) {
  console.error(JSON.stringify(failure(error)));
  process.exitCode = 1;
}
print({
  environment: 'sandbox',
  step,
  results,
  sandboxCannotProve: CANNOT_PROVE,
});
