import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { enrolOwner, noOtherStaff, withDatabase } from './ops-helpers';

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
    route.fulfill({
      status: 409,
      json: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'x' } },
    }),
  );
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('2000');
  await page.getByRole('button', { name: 'Withdraw NGN 2,000.00' }).click();
  await expect(
    page.getByText(
      'This withdrawal may already be on its way. Check your dashboard before asking again.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/please try again/i)).toHaveCount(0);
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

test('progress follows the real state only', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/activity', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            kind: 'withdrawal',
            id: 'w1',
            at: new Date().toISOString(),
            amountMinor: '2000000',
            state: 'processing',
            supporterLabel: null,
          },
          {
            kind: 'withdrawal',
            id: 'w2',
            at: '2026-10-24T09:00:00.000Z',
            amountMinor: '3500000',
            state: 'sent',
            supporterLabel: null,
          },
          {
            kind: 'withdrawal',
            id: 'w3',
            at: '2026-10-17T09:00:00.000Z',
            amountMinor: '1250000',
            state: 'failed',
            supporterLabel: null,
          },
        ],
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
  await expect(
    history.getByRole('listitem').filter({ hasText: '₦35,000' }),
  ).toContainText('Paid');
  await expect(
    history.getByRole('listitem').filter({ hasText: '₦12,500' }),
  ).toContainText('the money is back in your balance');
  await expectAccessible(page);
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
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  const bar = (await page
    .locator('nav[aria-label="Dashboard"]')
    .boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const end = (await button.boundingBox())!;
  expect(end.y + end.height).toBeLessThanOrEqual(bar.y);
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
