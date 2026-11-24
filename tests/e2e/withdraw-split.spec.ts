import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import { saveBank, withDatabase } from './ops-helpers';
import { shoot } from './split-shots';
import { E2E_REDIS_URL, stackEnv } from './stack';

/*
 * Per-provider balances, Task 9 (spec §6): one balance across the providers that hold a person's
 * money. Here the active pretend provider (`mock`) and the test-only withdraw-only `mock_alt` each
 * hold one tip, and `mock_alt` holds no more than its own: a withdrawal of everything arrives as
 * two payments. The person sees amounts and states only, never a provider's name.
 */

type Raw = { execute(query: string): Promise<{ rows: { id: string }[] }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped dist import in tests
type Ops = Record<string, any>;

const profileIdOf = (handle: string) =>
  withDatabase(async (db) => {
    const { rows } = await (db as Raw).execute(
      `SELECT id FROM profiles WHERE handle = '${handle}'`,
    );
    return rows[0]?.id as string;
  });

/** One ₦2,000 tip collected through `mock_alt`, recorded as its webhook would; its net, in kobo. */
async function tipThroughAlt(handle: string, profileId: string) {
  return withDatabase(async (db, ops: Ops) => {
    const before = (await ops.balanceOf(db, profileId)).availableMinor;
    const quote = await ops.createQuote(db, {
      handle,
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const intent = await ops.createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `mock_alt_pay_${randomUUID()}`;
    await ops.markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock_alt',
      providerReference: reference,
    });
    await ops.recordProviderEvent(db, {
      provider: 'mock_alt',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 200000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
    const after = (await ops.balanceOf(db, profileId)).availableMinor;
    return (after - before) as bigint;
  });
}

/**
 * What each pretend provider says it holds for this person: `mock` under the lane's prefix,
 * `mock_alt` under its own keys (`<prefix>:mock_alt`). Unmarked, `mock` would claim far more than
 * its own tip and carry the whole request alone.
 */
async function markBalances(profileId: string, minor: bigint) {
  // ioredis is the payments package's own dependency, as scripts/mock-pay.mjs loads it.
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as {
    Redis: new (url: string) => {
      set(key: string, value: string): Promise<unknown>;
      disconnect(): void;
    };
  };
  const redis = new Redis(E2E_REDIS_URL);
  try {
    for (const prefix of [
      stackEnv.QUEUE_PREFIX,
      `${stackEnv.QUEUE_PREFIX}:mock_alt`,
    ])
      await redis.set(
        `mockprovider:${prefix}:payout-balance:${profileId}`,
        minor.toString(),
      );
  } finally {
    redis.disconnect();
  }
}

/** A person whose ₦3,800 is held in two places: ₦1,900 at each provider. */
async function splitOwner(
  page: Page,
  browser: Parameters<typeof tipAsVisitor>[0],
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const { handle } = await signUpRecipient(page, testInfo);
  await saveBank(handle, 'GTBank', '6789');
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  const profileId = await profileIdOf(handle);
  const altNet = await tipThroughAlt(handle, profileId);
  // ₦1,900 at each: its own tip's net, less than the ₦3,800 total.
  await markBalances(profileId, altNet);
  return { handle, profileId };
}

const main = (page: Page) => page.locator('main');

test('a split owner sees one balance, withdraws, and sees two parts', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await splitOwner(page, browser, testInfo);
  await expect(async () => {
    await page.goto('/dashboard/withdraw');
    await expect(page.getByTestId('withdraw-available')).toHaveText('₦3,800', {
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  // One balance: the meter says the whole of it, and all of it can go.
  await expect(page.locator('.withdraw__meter')).toContainText(
    'Ready to withdraw ₦3,800',
  );
  const hint = main(page).getByTestId('withdraw-split-hint');
  await expect(hint).toHaveCount(0);
  await page.getByLabel('Amount (NGN)').fill('3800');
  await expect(page.getByTestId('you-receive')).toHaveText('₦3,800');
  await expect(hint).toHaveText('This may arrive as 2 payments.');
  await expect(main(page)).not.toContainText(/mock/i);
  await expectAccessible(page);
  await shoot(page, 'a-withdraw-form-2-payments', async () => {
    await page.getByLabel('Amount (NGN)').fill('3800');
    await expect(hint).toHaveText('This may arrive as 2 payments.');
  });

  await page.getByRole('button', { name: 'Withdraw ₦3,800' }).click();
  const receipt = main(page).locator('.withdraw__done');
  await expect(receipt).toContainText('Withdrawal requested');
  await expect(receipt.getByTestId('withdraw-split-done')).toHaveText(
    'This may arrive as 2 payments.',
  );
  const receiptParts = receipt.locator('.withdraw__parts > li');
  await expect(receiptParts).toHaveCount(2);
  await expect(receiptParts.nth(0)).toContainText('₦1,900');
  await expect(receiptParts.nth(1)).toContainText('₦1,900');

  // The list: one row for the request, its total and its two payments.
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦3,800' });
  await expect(row).toHaveCount(1);
  const rowParts = row.locator('.withdraw__parts > li');
  await expect(rowParts).toHaveCount(2);
  await expect(rowParts.nth(0)).toContainText(/₦1,900 (on its way|sent)/);
  await expect(rowParts.nth(1)).toContainText(/₦1,900 (on its way|sent)/);
  await expect(main(page)).not.toContainText(/mock/i);
  await expectAccessible(page);
});

test('a provider that can’t be read leaves the rest withdrawable', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await splitOwner(page, browser, testInfo);
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // One provider couldn't be read: the quote offers what the others hold, and says so.
  await page.route('**/v1/me/withdrawal-quote*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          withdrawableMinor: '190000',
          capsMinor: ['190000'],
          partial: true,
        },
      },
    });
  });
  await page.goto('/dashboard/withdraw');
  const notice = main(page).getByTestId('withdraw-extra-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText(
    'Some of your balance can’t be withdrawn right now. Try again later.',
  );
  await expect(page.locator('.withdraw__meter')).toContainText(
    'Ready to withdraw ₦1,900',
  );
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(page.getByLabel('Amount (NGN)')).toHaveValue('₦1,900');
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,900' }),
  ).toBeEnabled();
  await expect(main(page).getByTestId('withdraw-split-hint')).toHaveCount(0);
  await expect(main(page)).not.toContainText(/mock/i);
  await expectAccessible(page);
  await shoot(page, 'c-partial-notice', async () => {
    await expect(notice).toHaveCount(1);
  });
});

test('the receipt lists each payment of a split request', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await splitOwner(page, browser, testInfo);
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // The request's answer is held here, so the receipt can be shown again at each width; the real
  // request is the test above.
  await page.route('**/v1/me/withdrawals', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            data: {
              payoutId: randomUUID(),
              status: 'REQUESTED',
              groupId: randomUUID(),
              parts: [
                {
                  payoutId: randomUUID(),
                  amountMinor: '190000',
                  status: 'REQUESTED',
                },
                {
                  payoutId: randomUUID(),
                  amountMinor: '190000',
                  status: 'REQUESTED',
                },
              ],
            },
          },
        })
      : route.fallback(),
  );
  const receipt = main(page).locator('.withdraw__done');
  const withdraw = async () => {
    await expect(page.getByTestId('withdraw-available')).toHaveText('₦3,800');
    await page.getByLabel('Amount (NGN)').fill('3800');
    await page.getByRole('button', { name: 'Withdraw ₦3,800' }).click();
    await expect(receipt.getByTestId('withdraw-split-done')).toHaveText(
      'This may arrive as 2 payments.',
    );
  };
  await expect(async () => {
    await page.goto('/dashboard/withdraw');
    await expect(page.getByTestId('withdraw-available')).toHaveText('₦3,800', {
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await withdraw();
  const parts = receipt.locator('.withdraw__parts > li');
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toHaveText('₦1,900 on its way');
  await expect(parts.nth(1)).toHaveText('₦1,900 on its way');
  await expect(main(page)).not.toContainText(/mock/i);
  await expectAccessible(page);
  await shoot(page, 'b-receipt-two-parts', withdraw);
});

test('a request with one part sent and one on its way reads "Partly sent"', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // The pretend partner pays both parts within seconds, so the in-between state is answered here.
  const requestedAt = new Date(Date.now() - 60_000).toISOString();
  await page.route('**/v1/me/withdrawals', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            data: {
              items: [
                {
                  payoutId: randomUUID(),
                  requestedAt,
                  paidAt: null,
                  currency: 'NGN',
                  amountMinor: '8000000',
                  state: 'processing',
                  bank: { bankName: 'GTBank', last4: '6789' },
                  parts: [
                    { amountMinor: '6000000', state: 'sent' },
                    { amountMinor: '2000000', state: 'processing' },
                    { amountMinor: '2000000', state: 'failed' },
                  ],
                },
              ],
              nextCursor: null,
            },
          },
        })
      : route.fallback(),
  );
  await page.goto('/dashboard/withdraw');
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦80,000' });
  await expect(row).toContainText('Partly sent');
  const parts = row.locator('.withdraw__parts > li');
  await expect(parts).toHaveCount(3);
  await expect(parts.nth(0)).toHaveText('₦60,000 sent');
  await expect(parts.nth(1)).toHaveText('₦20,000 on its way');
  // Each part is released on its own when it fails (releaseFailedPayout).
  await expect(parts.nth(2)).toHaveText(
    '₦20,000 failed · back in your balance',
  );
  await expect(row).toContainText('to GTBank ••6789');
  await expectAccessible(page);
  await shoot(page, 'b-list-row-partly-sent', async () => {
    await expect(row).toContainText('Partly sent');
  });
});
