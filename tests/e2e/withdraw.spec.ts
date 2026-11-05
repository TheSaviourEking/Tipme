import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
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
  await expect(
    page.getByText(
      /You can withdraw ₦1,800 to .+ ••\d{4}\. TipMe pays the ₦50 transfer fee\./,
    ),
  ).toBeVisible();
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
  await expect(
    page.getByText(
      'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
    ),
  ).toBeVisible();
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
  await expect(
    page.getByRole('link', { name: 'Go to Get paid' }),
  ).toHaveAttribute('href', '/dashboard/settings#get-paid');

  await page.unroute('**/v1/me/withdrawal-quote');
  await fakeQuote(page, {
    state: 'ready',
    inReview: true,
    withdrawableMinor: '180000',
    ledgerMinor: '180000',
    providerMinor: '180000',
    feeMinor: '5000',
    destination: { bankName: 'GTBank', last4: '1234' },
  });
  await page.goto('/dashboard/withdraw');
  await expect(
    page.getByText('Your withdrawal is being checked by the payment provider.'),
  ).toBeVisible();
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
  await page.getByLabel('Amount (NGN)').fill('1800');
  await page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }).click();
  await expect(
    page.getByText(
      'This withdrawal may already be on its way. Check your dashboard before asking again.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/please try again/i)).toHaveCount(0);
});

// The quote's partner figures are cached for a few seconds; the withdrawal is checked fresh. A
// refusal over the amount must reload the figures, so the message never sits beside a stale amount.
for (const [code, message] of [
  ['INSUFFICIENT_BALANCE', 'That is more than your available balance.'],
  ['WITHDRAWAL_TOO_SMALL', 'The smallest withdrawal is NGN 2,000.'],
] as const) {
  test(`a refusal with ${code} reloads the amount and keeps its message`, async ({
    page,
    browser,
  }, testInfo) => {
    const { handle } = await signUpRecipient(page, testInfo);
    await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
    await page.goto('/dashboard/withdraw');
    await expect(page.getByText(/You can withdraw ₦1,800 to /)).toBeVisible();
    // What a fresh quote says by the time the request is refused.
    await fakeQuote(page, {
      state: 'ready',
      withdrawableMinor: '100000',
      ledgerMinor: '180000',
      providerMinor: '100000',
      feeMinor: '5000',
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
    await page.getByLabel('Amount (NGN)').fill('1800');
    await page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }).click();
    await reloaded;
    await expect(page.getByText(message)).toBeVisible();
    await expect(
      page.getByText(/You can withdraw ₦1,000 to GTBank ••1234/),
    ).toBeVisible();
    await expect(page.getByText(/You can withdraw ₦1,800/)).toHaveCount(0);
  });
}

test('Everything fills the whole balance, and under ₦2,000 it is the only way', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thanks' });
  await page.goto('/dashboard/withdraw');
  const everything = page.getByRole('button', { name: 'Everything' });
  await expect(everything).toBeVisible();
  // ₦1,800 is under the ₦2,000 minimum: no other amount key is offered.
  await expect(
    page.getByRole('group', { name: 'Quick amounts' }).getByRole('button'),
  ).toHaveCount(1);
  await everything.click();
  await expect(everything).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Amount (NGN)')).toHaveValue('₦1,800');
  await expect(
    page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }),
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
  await expect(summary.getByText('Going to')).toBeVisible();
  await expect(summary.getByText(/••\d{4}/)).toBeVisible();
  await expect(summary.getByRole('link', { name: 'Change' })).toHaveAttribute(
    'href',
    '/dashboard/settings#get-paid',
  );
  await expect(summary.getByText('You receive')).toBeVisible();
  // Withdrawing is free (TipMe pays the transfer fee), so what arrives is the amount.
  await expect(summary.getByTestId('you-receive')).toHaveText('₦1,800');
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
  await expect(
    history.getByRole('listitem').filter({ hasText: '₦12,500' }),
  ).toContainText('the money is back in your balance');
  await expect(
    history.getByRole('listitem').filter({ hasText: '••' }),
  ).toHaveCount(1);
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
  await page.getByLabel('Amount (NGN)').fill('1800');
  await page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  // More tips than the mixed activity feed holds.
  for (let batch = 0; batch < 3; batch += 1)
    await Promise.all(
      [0, 1, 2, 3].map(() => tipAsVisitor(browser, handle, { name: 'Tobi' })),
    );
  await page.goto('/dashboard/withdraw');
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦1,800' });
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
  await page.getByLabel('Amount (NGN)').fill('1800');
  await page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  await saveBank(handle, 'Kuda', '9876');
  await page.reload();
  const history = page.getByRole('region', { name: 'Your withdrawals' });
  const row = history.getByRole('listitem').filter({ hasText: '₦1,800' });
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
  const button = page.getByRole('button', { name: /^Withdraw NGN/ });
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
const COULDNT_CONFIRM =
  'We couldn’t confirm your withdrawal. Check your dashboard before trying again.';

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
  await page.getByRole('button', { name: /^Withdraw NGN/ }).click();
  await expect(page.getByText(COULDNT_CONFIRM)).toBeVisible();
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(page.getByText(COULDNT_CONFIRM)).toBeVisible();
  await page.getByRole('button', { name: /^Withdraw NGN/ }).click();
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
  await page.getByRole('button', { name: /^Withdraw NGN/ }).click();
  await expect(page.getByText(COULDNT_CONFIRM)).toBeVisible();
  await page.getByLabel('Amount (NGN)').fill('2000');
  await expect(page.getByText(COULDNT_CONFIRM)).toHaveCount(0);
  await page.getByRole('button', { name: 'Withdraw NGN 2,000.00' }).click();
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
  // ₦1,800 is all there is: ₦1,500 is under the minimum and is not the whole balance.
  await page.getByLabel('Amount (NGN)').fill('1500');
  await expect(page.getByTestId('you-receive')).toHaveText('—');
  await expect(page.getByTestId('balance-afterwards')).toHaveText('—');
  await expect(
    page.getByText(/The smallest withdrawal is ₦2,000/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Withdraw NGN 1,500.00' }),
  ).toBeDisabled();
  // More than can be withdrawn is no better.
  await page.getByLabel('Amount (NGN)').fill('5000');
  await expect(page.getByTestId('you-receive')).toHaveText('—');
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(page.getByTestId('you-receive')).toHaveText('₦1,800');
  await expect(
    page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }),
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
