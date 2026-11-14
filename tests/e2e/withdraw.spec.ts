import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { LONG_NAME, UNBROKEN_NAME } from './profile-fixtures';
import {
  enrolOwner,
  noOtherStaff,
  saveBank,
  withDatabase,
} from './ops-helpers';

// The pretend provider has no connected accounts and never fails a read, so it can only reach
// `ready` and (through a real hold) `paused`. The states it can't produce are answered here at the
// API boundary; withdraw-state.test.mjs and the database tests cover the same states underneath.
type Raw = {
  execute(query: string): Promise<{ rows: { id: string }[] }>;
  transaction(task: (tx: unknown) => Promise<void>): Promise<void>;
};

const fakeQuote = (page: Page, quote: Record<string, unknown>) =>
  page.route('**/v1/me/withdrawal-quote', (route) =>
    route.fulfill({ json: { data: { inReview: false, ...quote } } }),
  );

/** The dashboard's real answer, with the available balance set (no tips needed). */
const fakeBalance = (page: Page, availableMinor: string) =>
  page.route('**/v1/me/dashboard', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, availableMinor } },
    });
  });

const readyQuote = (over: Record<string, unknown> = {}) => ({
  state: 'ready',
  withdrawableMinor: '540000',
  ledgerMinor: '540000',
  providerMinor: '540000',
  feeMinor: '0',
  feePaidBy: 'user',
  destination: { bankName: 'GTBank', last4: '1234' },
  ...over,
});

const meter = (page: Page) => page.locator('.withdraw__meter');
const TOO_SMALL =
  'Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less.';

test('the withdraw page: ready, nothing yet, and a real pause', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/withdraw');
  await expect(
    page.getByText('You have nothing to withdraw yet.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeDisabled();

  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.reload();
  await expect(meter(page)).toContainText('Ready to withdraw ₦1,860');
  // Owner, 12 Nov 2026: the user pays the transfer fee, from the amount.
  await expect(meter(page)).toContainText(
    'Transfer fee: ₦50, charged by our payment partner. It comes off the amount you withdraw.',
  );
  const chip = meter(page).locator('.withdraw__chip');
  await expect(chip).toContainText(/to .+ ••\d{4}/);
  await expect(chip.getByRole('link', { name: 'Change' })).toHaveAttribute(
    'href',
    '/dashboard/settings#get-paid',
  );
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
  await expectAccessible(page);

  await withDatabase(async (db, ops) => {
    const handleDb = db as Raw;
    const { rows } = await handleDb.execute(
      `SELECT id FROM profiles WHERE handle = '${handle}'`,
    );
    const profileId = rows[0]?.id;
    const issue = await ops.openIssue(db, {
      dedupeKey: `e2e_hold.${profileId}`,
      kind: 'provider_in_debt',
      subject: { profileId },
      now: new Date(),
    });
    await handleDb.transaction((tx) =>
      ops.holdWithdrawals(tx, {
        profileId,
        reason: 'in_debt',
        issueId: issue.id,
      }),
    );
  });
  await page.reload();
  const warning = page.locator('.tm-warning');
  await expect(warning).toContainText(
    'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
  );
  await expect(warning).toHaveAttribute('role', 'status');
  await expect(meter(page)).toContainText('Paused for now');
  await expect(page.getByLabel('Amount (NGN)')).toHaveCount(0);
  await expectAccessible(page);
});

test('the withdraw page says every state the provider can put it in', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const cases: [Record<string, unknown>, string, boolean][] = [
    [
      { state: 'provider_unavailable' },
      'We can’t check your balance with our payment partner right now. Try again in a few minutes.',
      true,
    ],
    [
      { state: 'no_destination' },
      'Add the bank account you want to be paid to.',
      false,
    ],
    [
      { state: 'setup_needed', requirementsDue: [] },
      'Finish setting up how you get paid to withdraw.',
      false,
    ],
    [
      { state: 'destination_pending' },
      'Your bank account is being checked. You can withdraw once it’s confirmed.',
      false,
    ],
    [
      {
        state: 'ready',
        withdrawableMinor: '0',
        ledgerMinor: '180000',
        providerMinor: '0',
        feeMinor: '5000',
        feePaidBy: 'user',
        destination: { bankName: 'GTBank', last4: '1234' },
      },
      'Your tips are still on the way to your account with our payment partner. You can withdraw them once they arrive.',
      true,
    ],
  ];
  for (const [quote, copy, form] of cases) {
    await page.unroute('**/v1/me/withdrawal-quote');
    await fakeQuote(page, quote);
    await page.goto('/dashboard/withdraw');
    await expect(page.getByText(copy)).toBeVisible();
    await expect(page.locator('.tm-notice')).toHaveCount(0);
    if (form)
      await expect(
        page.getByRole('button', { name: 'Withdraw' }),
      ).toBeDisabled();
    else await expect(page.getByLabel('Amount (NGN)')).toHaveCount(0);
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
  }
  await page.unroute('**/v1/me/withdrawal-quote');
  await fakeQuote(page, { state: 'no_destination' });
  await page.goto('/dashboard/withdraw');
  const slip = page.locator('.tm-slip');
  await expect(slip).toContainText('Add your bank account');
  await expect(slip).toHaveAttribute('role', 'status');
  await expect(meter(page)).toContainText('Add a bank to withdraw');
  await expect(
    slip.getByRole('link', { name: 'Go to Get paid' }),
  ).toHaveAttribute('href', '/dashboard/settings#get-paid');

  await page.unroute('**/v1/me/withdrawal-quote');
  await fakeQuote(page, {
    state: 'ready',
    inReview: true,
    withdrawableMinor: '180000',
    ledgerMinor: '180000',
    providerMinor: '180000',
    feeMinor: '5000',
    feePaidBy: 'user',
    destination: { bankName: 'GTBank', last4: '1234' },
  });
  await page.goto('/dashboard/withdraw');
  await expect(meter(page)).toContainText(
    'Our payment partner is checking it.',
  );
});

test('an idempotency conflict never says to simply try again', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.route('**/v1/me/withdrawals', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'x' } },
        })
      : route.continue(),
  );
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1860');
  await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
  const slip = page.locator('.tm-slip--unsure');
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(slip.locator('.tm-slip__title')).toHaveText(
    'This withdrawal may already be on its way',
  );
  await expect(slip).toContainText('Check your dashboard before asking again.');
  await expect(slip.locator('.tm-slip__safe')).toHaveCount(0);
  await expect(page.getByLabel('Amount (NGN)')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByText(/please try again/i)).toHaveCount(0);
});

// The quote's partner figures are cached for a few seconds; the withdrawal is checked fresh. A
// refusal over the amount must reload the figures, so the message never sits beside a stale amount.
for (const [code, message] of [
  ['INSUFFICIENT_BALANCE', 'That is more than your available balance.'],
  ['WITHDRAWAL_TOO_SMALL', 'The smallest withdrawal is ₦2,000.'],
] as const) {
  test(`a refusal with ${code} reloads the amount and keeps its message`, async ({
    page,
    browser,
  }, testInfo) => {
    const { handle } = await signUpRecipient(page, testInfo);
    await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
    await page.goto('/dashboard/withdraw');
    await expect(meter(page)).toContainText('Ready to withdraw ₦1,860');
    // What a fresh quote says by the time the request is refused.
    await fakeQuote(page, {
      state: 'ready',
      withdrawableMinor: '100000',
      ledgerMinor: '186000',
      providerMinor: '100000',
      feeMinor: '5000',
      feePaidBy: 'user',
      destination: { bankName: 'GTBank', last4: '1234' },
    });
    await page.route('**/v1/me/withdrawals', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 409,
            json: { error: { code, message: 'x' } },
          })
        : route.continue(),
    );
    const reloaded = page.waitForRequest(
      (request) =>
        request.url().endsWith('/v1/me/withdrawal-quote') &&
        request.method() === 'GET',
    );
    await page.getByLabel('Amount (NGN)').fill('1860');
    await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
    await reloaded;
    // Still the field's own line, beside the amount.
    await expect(page.locator('.tm-field-error')).toHaveText(message);
    await expect(meter(page)).toContainText('Ready to withdraw ₦1,000');
    await expect(meter(page).locator('.withdraw__chip')).toContainText(
      'GTBank ••1234',
    );
    await expect(page.getByText('Ready to withdraw ₦1,860')).toHaveCount(0);
  });
}

test('the withdraw screen writes every amount one way, and the minimum comes from the policy', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  await expect(
    meter(page).getByRole('heading', { name: 'Available' }),
  ).toBeVisible();
  await expect(page.getByTestId('withdraw-available')).toHaveText('₦1,860');
  // The minimum in the hint is the policy's, written in the same format.
  await expect(
    page.getByText(/The smallest withdrawal is ₦2,000, or your whole balance/),
  ).toBeVisible();
  await page.getByLabel('Amount (NGN)').fill('1860');
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,860' }),
  ).toBeEnabled();
  // No amount on this screen is written as "NGN 1,860.00".
  await expect(page.locator('main')).not.toContainText(/NGN \d/);
});

test('Everything fills the whole balance, and under ₦2,000 it is the only way', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  const everything = page.getByRole('button', { name: 'Everything' });
  await expect(everything).toBeVisible();
  // ₦1,860 is under the ₦2,000 minimum: no other amount key is offered.
  await expect(
    page.getByRole('group', { name: 'Quick amounts' }).getByRole('button'),
  ).toHaveCount(1);
  await everything.click();
  await expect(everything).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Amount (NGN)')).toHaveValue('₦1,860');
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,860' }),
  ).toBeEnabled();
  // Typing something else lets go of Everything.
  await page.getByLabel('Amount (NGN)').fill('1000');
  await expect(everything).toHaveAttribute('aria-pressed', 'false');
});

test('the summary says where it goes, what arrives and what is left', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  await page.getByRole('button', { name: 'Everything' }).click();
  const summary = page.getByRole('region', { name: 'Summary' });
  // Where it goes is the instrument's bank chip, with Change beside it.
  const chip = meter(page).locator('.withdraw__chip');
  await expect(chip.getByText(/••\d{4}/)).toBeVisible();
  await expect(chip.getByRole('link', { name: 'Change' })).toHaveAttribute(
    'href',
    '/dashboard/settings#get-paid',
  );
  await expect(summary.getByText('Going to')).toHaveCount(0);
  await expect(summary.getByText('You’ll receive')).toBeVisible();
  // The ₦50 transfer fee comes off the amount (owner, 12 Nov 2026): Everything sends the rest.
  await expect(summary.getByTestId('transfer-fee')).toHaveText('₦50');
  await expect(summary.getByTestId('you-receive')).toHaveText('₦1,810');
  await expect(summary.getByText('Balance afterwards')).toBeVisible();
  await expect(summary.getByTestId('balance-afterwards')).toHaveText('₦0');
  await expectAccessible(page);
});

const withdrawal = (over: Record<string, unknown>) => ({
  payoutId: 'w',
  requestedAt: '2026-10-24T09:00:00.000000Z',
  paidAt: null,
  currency: 'NGN',
  amountMinor: '1000000',
  state: 'requested',
  bank: null,
  ...over,
});

test('progress follows the real state only', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/withdrawals*', (route) =>
    route.request().method() !== 'GET'
      ? route.continue()
      : route.fulfill({
          json: {
            data: {
              nextCursor: null,
              items: [
                withdrawal({
                  payoutId: 'w1',
                  requestedAt: new Date().toISOString(),
                  amountMinor: '2000000',
                  state: 'processing',
                }),
                withdrawal({
                  payoutId: 'w2',
                  requestedAt: '2026-10-24T08:00:00.000000Z',
                  paidAt: '2026-10-24T09:00:00.000000Z',
                  amountMinor: '3500000',
                  state: 'sent',
                  bank: { bankName: 'GTBank', last4: '6789' },
                }),
                withdrawal({
                  payoutId: 'w3',
                  requestedAt: '2026-10-17T09:00:00.000000Z',
                  amountMinor: '1250000',
                  state: 'failed',
                }),
                withdrawal({
                  payoutId: 'w4',
                  requestedAt: '2026-10-10T09:00:00.000000Z',
                  amountMinor: '750000',
                  state: 'reversed',
                }),
              ],
            },
          },
        }),
  );
  await page.goto('/dashboard/withdraw');
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const moving = history.getByRole('listitem').filter({ hasText: '₦20,000' });
  await expect(moving.getByText('On its way')).toBeVisible();
  const steps = moving.getByRole('list', { name: 'Progress' });
  await expect(steps.getByRole('listitem')).toHaveCount(3);
  await expect(steps.locator('[data-filled="true"]')).toHaveCount(2);
  // Paid only because the API says sent; a failed one says the money is back.
  const paid = history.getByRole('listitem').filter({ hasText: '₦35,000' });
  await expect(paid).toContainText('Paid');
  // The bank is the one recorded on the withdrawal; a row without one says nothing of a bank.
  await expect(paid).toContainText('to GTBank ••6789');
  await expect(moving).not.toContainText('••');
  const failed = history.getByRole('listitem').filter({ hasText: '₦12,500' });
  await expect(failed).toContainText('the money is back in your balance');
  await expect(
    history.getByRole('listitem').filter({ hasText: '••' }),
  ).toHaveCount(1);
  // The ledger: each row's state is a stamp in its own words (capitals are only CSS).
  await expect(moving.locator('.tm-stamp')).toHaveText('On its way');
  await expect(paid.locator('.tm-stamp')).toHaveText('Paid');
  await expect(failed.locator('.tm-stamp')).toHaveText('Failed');
  // Only a row the API reports failed says what came back, and with that row's amount.
  await expect(failed.locator('.withdraw__back')).toHaveText(
    'Back in your balance: ₦12,500',
  );
  await expect(history.locator('.withdraw__back')).toHaveCount(1);
  const reversed = history.getByRole('listitem').filter({ hasText: '₦7,500' });
  await expect(reversed.locator('.tm-stamp')).toHaveText('Reversed');
  await expect(reversed.locator('.withdraw__back')).toHaveCount(0);
  await expect(reversed).not.toContainText('Back in your balance');
  // Rows are history: nothing in the ledger is announced.
  await expect(failed).not.toHaveAttribute('role', /.+/);
  await expect(
    history.locator('ol [role="alert"], ol [role="status"]'),
  ).toHaveCount(0);
  await expectAccessible(page);
});

test('an older withdrawal stays listed after many tips', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await saveBank(handle, 'GTBank', '6789');
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1860');
  await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  // More tips than the mixed activity feed holds.
  for (let batch = 0; batch < 3; batch += 1)
    await Promise.all(
      [0, 1, 2, 3].map(() => tipAsVisitor(browser, handle, { name: 'Tobi' })),
    );
  await page.goto('/dashboard/withdraw');
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦1,810' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(/Requested|On its way|Paid/);
  await expect(row).toContainText('to GTBank ••6789');
});

test('a past withdrawal keeps its bank after the bank changes', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await saveBank(handle, 'GTBank', '6789');
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1860');
  await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  await saveBank(handle, 'Kuda', '9876');
  await page.reload();
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦1,810' });
  await expect(row).toContainText('to GTBank ••6789');
  await expect(row).not.toContainText('9876');
  await expect(row).not.toContainText('Kuda');
});

test('more withdrawals load on request', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/withdrawals*', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const second =
      new URL(route.request().url()).searchParams.get('cursor') === 'c1';
    return route.fulfill({
      json: {
        data: second
          ? {
              nextCursor: null,
              items: [
                withdrawal({
                  payoutId: 'w3',
                  amountMinor: '3000000',
                  state: 'sent',
                }),
                withdrawal({
                  payoutId: 'w4',
                  amountMinor: '4000000',
                  state: 'failed',
                }),
              ],
            }
          : {
              nextCursor: 'c1',
              items: [
                withdrawal({ payoutId: 'w1', amountMinor: '1000000' }),
                withdrawal({ payoutId: 'w2', amountMinor: '2000000' }),
              ],
            },
      },
    });
  });
  await page.goto('/dashboard/withdraw');
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  await expect(
    history.getByRole('listitem').filter({ hasText: '₦10,000' }),
  ).toHaveCount(1);
  await history.getByRole('button', { name: 'Show more' }).click();
  await expect(
    history.getByRole('listitem').filter({ hasText: '₦40,000' }),
  ).toHaveCount(1);
  for (const amount of ['₦10,000', '₦20,000', '₦30,000', '₦40,000'])
    await expect(
      history.getByRole('listitem').filter({ hasText: amount }),
    ).toHaveCount(1);
  await expect(history.getByRole('button', { name: 'Show more' })).toHaveCount(
    0,
  );
});

test('the withdraw page fits a phone, clear of the tab bar @mobile', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  await page.getByRole('button', { name: 'Everything' }).click();
  expect(await fitsViewport(page)).toBe(true);
  const button = page.getByRole('button', { name: /^Withdraw ₦/ });
  const nav = page.locator('nav[aria-label="Dashboard"]');
  const start = (await button.boundingBox())!;
  expect(start.height).toBeGreaterThanOrEqual(44);
  // A screen just tall enough that the button is on it but its lower half sits under the fixed
  // tab bar, whatever the fonts: the case CI met. A keyboard user tabbing to it gets it in view.
  const barHeight = (await nav.boundingBox())!.height;
  await page.setViewportSize({
    width: 390,
    height: Math.ceil(start.y + start.height / 2 + barHeight),
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await button.focus();
  const box = (await button.boundingBox())!;
  const bar = (await nav.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const end = (await button.boundingBox())!;
  expect(end.y + end.height).toBeLessThanOrEqual(bar.y);

  // Every state at 320px, with long bank names: the instrument, then the slip or the form, then
  // the ledger, in that order, and nothing wider than the screen.
  await page.setViewportSize({ width: 320, height: 720 });
  await fakeBalance(page, '540000');
  // The ledger at 320px: an open row with its step lamps, a failed row's line, long bank names.
  await page.route('**/v1/me/withdrawals*', (route) =>
    route.request().method() !== 'GET'
      ? route.continue()
      : route.fulfill({
          json: {
            data: {
              nextCursor: null,
              items: [
                withdrawal({
                  payoutId: 'w1',
                  amountMinor: '2000000',
                  state: 'in_review',
                  bank: { bankName: LONG_NAME, last4: '6789' },
                }),
                withdrawal({
                  payoutId: 'w2',
                  amountMinor: '125000000',
                  state: 'failed',
                  bank: { bankName: UNBROKEN_NAME, last4: '6789' },
                }),
              ],
            },
          },
        }),
  );
  const states: [string, Record<string, unknown>, string | null][] = [
    [
      'ready',
      readyQuote({ destination: { bankName: LONG_NAME, last4: '1234' } }),
      '.withdraw__panel',
    ],
    [
      'ready, unbroken bank',
      readyQuote({ destination: { bankName: UNBROKEN_NAME, last4: '1234' } }),
      '.withdraw__panel',
    ],
    ['no bank', { state: 'no_destination' }, '.withdraw__money .tm-slip'],
    ['paused', { state: 'paused', reason: 'switched_off' }, null],
  ];
  for (const [name, quote, middle] of states) {
    await page.unroute('**/v1/me/withdrawal-quote');
    await fakeQuote(page, quote);
    await page.goto('/dashboard/withdraw');
    await expect(meter(page)).toBeVisible();
    await expect(page.locator('.withdraw__back')).toBeVisible();
    expect(await fitsViewport(page), name).toBe(true);
    const top = async (selector: string) =>
      (await page.locator(selector).first().boundingBox())!.y;
    const ledger = await top('.withdraw__history');
    const instrument = await top('.withdraw__meter');
    if (middle) {
      const between = await top(middle);
      expect(instrument, name).toBeLessThan(between);
      expect(between, name).toBeLessThan(ledger);
    } else expect(instrument, name).toBeLessThan(ledger);
  }
});

// Every withdrawal request from a page, with the key it carried. The first answers are ambiguous
// (503), the kind that may follow a request that did arrive.
async function failingRequests(page: Page) {
  const keys: string[] = [];
  await page.route('**/v1/me/withdrawals', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    return route.fulfill({
      status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x' } },
    });
  });
  return keys;
}
// The answer that may follow a request that arrived: a Not confirmed slip, not a field error.
const couldntConfirm = (page: Page) =>
  page
    .locator('.tm-slip--unsure')
    .filter({ hasText: 'We couldn’t confirm your withdrawal' })
    .filter({ hasText: 'Check your dashboard before trying again.' });

test('tapping the amount already chosen keeps the request key and the warning', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await tipAsVisitor(browser, handle, { name: 'Bo K.', message: 'Thanks' });
  const keys = await failingRequests(page);
  await page.goto('/dashboard/withdraw');
  await page.getByRole('button', { name: 'Everything' }).click();
  await page.getByRole('button', { name: /^Withdraw ₦/ }).click();
  await expect(couldntConfirm(page)).toBeVisible();
  // The words are on the slip, an alert; the amount itself was not wrong.
  await expect(couldntConfirm(page)).toHaveAttribute('role', 'alert');
  await expect(page.getByLabel('Amount (NGN)')).toHaveAttribute(
    'aria-invalid',
    'false',
  );
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(couldntConfirm(page)).toBeVisible();
  await page.getByRole('button', { name: /^Withdraw ₦/ }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]).not.toBe('');
});

test('changing the amount makes a new request key', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await tipAsVisitor(browser, handle, { name: 'Bo K.', message: 'Thanks' });
  const keys = await failingRequests(page);
  await page.goto('/dashboard/withdraw');
  await page.getByRole('button', { name: 'Everything' }).click();
  await page.getByRole('button', { name: /^Withdraw ₦/ }).click();
  await expect(couldntConfirm(page)).toBeVisible();
  await page.getByLabel('Amount (NGN)').fill('2000');
  await expect(couldntConfirm(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Withdraw ₦2,000' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

test('figures are shown only for an amount that can be sent', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  // ₦1,860 is all there is: ₦1,500 is under the minimum and is not the whole balance.
  await page.getByLabel('Amount (NGN)').fill('1500');
  await expect(page.getByTestId('you-receive')).toHaveText('—');
  await expect(page.getByTestId('balance-afterwards')).toHaveText('—');
  await expect(
    page.getByText(/The smallest withdrawal is ₦2,000/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,500' }),
  ).toBeDisabled();
  // More than can be withdrawn is no better.
  await page.getByLabel('Amount (NGN)').fill('5000');
  await expect(page.getByTestId('you-receive')).toHaveText('—');
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(page.getByTestId('you-receive')).toHaveText('₦1,810');
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,860' }),
  ).toBeEnabled();
});

test('@alone staff ask the provider first, and are offered only what its answer allows', async ({
  page,
}, testInfo) => {
  await noOtherStaff();
  await enrolOwner(page, testInfo);
  const issueId = await withDatabase(async (db, ops) => {
    const raw = db as Raw;
    const { rows } = await raw.execute(
      `SELECT id FROM profiles WHERE handle = 'tobi'`,
    );
    const payoutId = crypto.randomUUID();
    await raw.execute(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint, provider, start_step, start_uncertain_at, created_at)
       VALUES ('${payoutId}', '${rows[0]?.id}', 'NGN', 100, 'REQUESTED', '${crypto.randomUUID()}', 'f', 'mock', 'fee', now() - interval '2 hours', now() - interval '2 hours')`,
    );
    return (
      await ops.openIssue(db, {
        dedupeKey: `e2e_unresolved.${payoutId}`,
        kind: 'payout_unresolved',
        subject: { payoutId },
        now: new Date(),
      })
    ).id as string;
  });
  await page.goto(`/ops/issues/${issueId}`);
  await expect(
    page.getByRole('button', { name: 'Mark failed and release' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask the provider' }).click();
  await expect(
    page.getByText('The provider has no payout with TipMe’s reference.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Resume this withdrawal/ }),
  ).toHaveCount(0);
  await expectAccessible(page);
  await page
    .getByLabel('What did you find at the provider?')
    .fill('Searched the dashboard by payout id: nothing there.');
  await page
    .getByLabel(
      'I checked the provider’s dashboard, and this payout is not there.',
    )
    .check();
  await page.getByRole('button', { name: 'Mark failed and release' }).click();
  await expect(
    page.getByText(
      'The withdrawal is marked failed and its money is available to the recipient again.',
    ),
  ).toBeVisible();
  await expect(
    page.locator('.ops-issue__status').getByText('Resolved', { exact: true }),
  ).toBeVisible();
});

// Live updates, PR 2 (plan Task 14): a second open Withdraw tab follows the payout. Its panels never
// re-read on a resync or the fallback poll, so only a live signal can change it.
test('a pretend payout paid changes the status in an open tab without a reload, with no celebration', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await expect(async () => {
    await page.goto('/dashboard/withdraw');
    await expect(page.getByTestId('withdraw-available')).toHaveText('₦1,860', {
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  const watching = await page.context().newPage();
  await watching.goto('/dashboard/withdraw');
  await expect(watching.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await watching.evaluate(() => {
    (window as unknown as { __noReload: number }).__noReload = 1;
  });
  const quotes: string[] = [];
  watching.on('request', (request) => {
    if (request.url().includes('/v1/me/withdrawal-quote'))
      quotes.push(new URL(request.url()).search);
  });

  await page.getByLabel('Amount (NGN)').fill('1860');
  await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();

  const history = watching.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦1,810' });
  // Requested, then paid: the pretend partner pays within seconds.
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText('Paid', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(watching.getByTestId('withdraw-available')).toHaveText('₦0');
  // Withdrawals never celebrate: the row changes colour and label, nothing moves.
  expect(
    await row.evaluate(
      (el) =>
        el
          .getAnimations({ subtree: true })
          .filter((a) => a.playState === 'running').length,
    ),
  ).toBe(0);
  expect(
    await watching.evaluate(
      () => (window as unknown as { __noReload?: number }).__noReload,
    ),
  ).toBe(1);
  // A signal never asks the payment partner: every quote this tab read after the load was local.
  expect(quotes.length).toBeGreaterThan(0);
  expect(quotes.every((search) => search === '?scope=local')).toBe(true);
  await expectAccessible(watching);
});

test('a withdrawal we could not confirm is a Not confirmed slip with no money line, and Withdraw again sends the same key', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await fakeBalance(page, '540000');
  await fakeQuote(page, readyQuote());
  const keys: string[] = [];
  // The second answer is held until the amount has changed: an answer that lands after the person
  // typed a new amount must not bring the old slip back (it did, on CI's slower machines).
  let release = () => {};
  const changed = new Promise<void>((done) => (release = done));
  await page.route('**/v1/me/withdrawals', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (keys.length === 2) await changed;
    return route.fulfill({
      status: 502,
      json: { error: { code: 'INTERNAL_ERROR', message: 'x' } },
    });
  });
  await page.goto('/dashboard/withdraw');
  // ₦1,800 is under the minimum against ₦5,400; ₦2,500 can go.
  await page.getByLabel('Amount (NGN)').fill('2500');
  await page.getByRole('button', { name: 'Withdraw ₦2,500' }).click();
  const slip = page.locator('.tm-slip--unsure');
  await expect(slip.locator('.tm-slip__title')).toHaveText(
    'We couldn’t confirm your withdrawal',
  );
  await expect(slip).toContainText('Check your dashboard before trying again.');
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(slip.locator('.tm-slip__safe')).toHaveCount(0);
  await expect(slip).not.toContainText(/money|balance|paid|safe/i);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Withdraw ₦2,500' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  // A different amount is a new request: the slip goes, and the next key is new.
  await page.getByLabel('Amount (NGN)').fill('2700');
  await expect(slip).toHaveCount(0);
  // The held answer for ₦2,500 lands now, after the change: the slip stays gone.
  const late = page.waitForResponse('**/v1/me/withdrawals');
  release();
  await late;
  await expect(slip).toHaveCount(0);
  await page.getByRole('button', { name: 'Withdraw ₦2,700' }).click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[0]);
});

test('withdrawal requested is a done slip, and the instrument shows what the API says after', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  await expect(page.getByTestId('withdraw-available')).toHaveText('₦1,860');
  await page.getByLabel('Amount (NGN)').fill('1860');
  // The figure changes only from the dashboard's own answer, re-read after the request.
  const reread = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/me/dashboard') &&
      response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Withdraw ₦1,860' }).click();
  const done = page.locator('.tm-slip--done');
  await expect(done).toHaveAttribute('role', 'status');
  await expect(done.locator('.tm-slip__title')).toHaveText(
    'Withdrawal requested',
  );
  await expect(done).toContainText('₦1,810 is on its way to your test bank.');
  await expect(
    done.getByRole('link', { name: 'Back to your dashboard' }),
  ).toHaveAttribute('href', '/dashboard');
  const after = (await (await reread).json()) as {
    data: { availableMinor: string };
  };
  expect(after.data.availableMinor).toBe('0');
  await expect(page.getByTestId('withdraw-available')).toHaveText('₦0');
  await expectAccessible(page);
});

test('below the minimum: a red edge and Too small when leaving the field, nothing sent, and the key unchanged', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await fakeBalance(page, '540000');
  await fakeQuote(page, readyQuote());
  let posts = 0;
  await page.route('**/v1/me/withdrawals', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    return route.fulfill({
      status: 502,
      json: { error: { code: 'INTERNAL_ERROR', message: 'x' } },
    });
  });
  await page.goto('/dashboard/withdraw');
  const field = page.getByLabel('Amount (NGN)');
  await field.fill('1500');
  // Typing announces nothing (the router's own announcer is outside the page).
  await expect(page.locator('.withdraw').getByRole('alert')).toHaveCount(0);
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await field.press('Tab');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.tm-field-error')).toHaveText(TOO_SMALL);
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦1,500' }),
  ).toBeDisabled();
  await expect(page.getByTestId('you-receive')).toHaveText('—');
  await expect(page.getByTestId('balance-afterwards')).toHaveText('—');
  await field.focus();
  await field.press('Enter');
  await expect(page.locator('.tm-field-error')).toHaveText(TOO_SMALL);
  expect(posts).toBe(0);
  await expectAccessible(page);
  await field.fill('2000');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('.tm-field-error')).toHaveCount(0);
  expect(posts).toBe(0);
});

test('a visit reads the quote once, and a refusal over the amount reads it once more', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await fakeBalance(page, '540000');
  await fakeQuote(page, readyQuote());
  let reads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/v1/me/withdrawal-quote'
    )
      reads += 1;
  });
  await page.route('**/v1/me/withdrawals', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'INSUFFICIENT_BALANCE', message: 'x' } },
        })
      : route.continue(),
  );
  await page.goto('/dashboard/withdraw');
  await expect(meter(page)).toContainText('Ready to withdraw ₦5,400');
  expect(reads).toBe(1);
  // ₦1,800 is under the minimum against ₦5,400; ₦2,500 can go.
  await page.getByLabel('Amount (NGN)').fill('2500');
  await page.getByRole('button', { name: 'Withdraw ₦2,500' }).click();
  await expect(page.locator('.tm-field-error')).toHaveText(
    'That is more than your available balance.',
  );
  await expect.poll(() => reads).toBe(2);
  // Nothing else on the page reads it: the pill, the quick amounts, leaving the field.
  await page.locator('.test-pill summary').click();
  await page.getByRole('button', { name: '₦5,000' }).click();
  await page.getByRole('button', { name: 'Everything' }).click();
  await page.getByLabel('Amount (NGN)').focus();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);
  expect(reads).toBe(2);
});

// Owner, 12 Nov 2026: users pay the ₦50 transfer fee, taken from the amount.
test('withdraw ₦10,000: the screen shows the ₦50 fee and that ₦9,950 arrives', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await fakeBalance(page, '1000000');
  await fakeQuote(
    page,
    readyQuote({
      withdrawableMinor: '1000000',
      ledgerMinor: '1000000',
      providerMinor: '1000000',
      feeMinor: '5000',
    }),
  );
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('10000');
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary.getByTestId('transfer-fee')).toHaveText('₦50');
  await expect(summary.getByTestId('you-receive')).toHaveText('₦9,950');
  await expect(summary.getByTestId('balance-afterwards')).toHaveText('₦0');
  await expect(
    page.getByRole('button', { name: 'Withdraw ₦10,000' }),
  ).toBeEnabled();
  await expect(page.getByText(/TipMe pays the ₦50/)).toHaveCount(0);
});

test('a balance of ₦50 or less says why it can’t be withdrawn', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await fakeBalance(page, '4000');
  await fakeQuote(
    page,
    readyQuote({
      withdrawableMinor: '4000',
      ledgerMinor: '4000',
      providerMinor: '4000',
      feeMinor: '5000',
    }),
  );
  await page.goto('/dashboard/withdraw');
  await expect(
    page.getByText(
      'Your ₦40 isn’t more than the ₦50 transfer fee, so it can’t be withdrawn yet. It stays in your balance.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Withdraw/ })).toBeDisabled();
});
