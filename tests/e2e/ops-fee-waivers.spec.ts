import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity, signUpRecipient } from './helpers';
import {
  codeFor,
  enrolOwner,
  grantOwner,
  secondOwner,
  sql,
  withDatabase,
} from './ops-helpers';
import { API_ORIGIN } from './stack';

// Fee waivers (spec 2026-11-23 §6): staff choose when TipMe pays the tip fee or the withdrawal fee.
// Only account-scope rules are ever written here: a kind-wide rule would change every parallel
// test's fees. The kind-wide change is answered by a routed API, so it never reaches the server.

const DAY_MS = 86_400_000;

const domain = () => import('../../packages/domain/dist/index.js');

/** The Lagos date `days` from now (YYYY-MM-DD), and how the screens word its end. */
async function lagosDateIn(days: number) {
  const { endOfLagosDayIso, lagosDateOf, untilWords } = await domain();
  const date: string = lagosDateOf(new Date(Date.now() + days * DAY_MS));
  const endsAt: string = endOfLagosDayIso(date);
  return {
    date,
    endsAt,
    until: untilWords(new Date(endsAt), new Date()) as string,
    untilWithYear: (await domain()).untilWordsWithYear(
      new Date(endsAt),
    ) as string,
  };
}

const staffWord = (id: string) => `staff …${id.slice(-6)}`;

async function userIdOf(email: string) {
  const [row] = await sql<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

async function profileIdOf(handle: string) {
  const [row] = await sql<{ id: string }>(
    'SELECT id FROM profiles WHERE handle = $1',
    [handle],
  );
  if (!row) throw new Error(`no page ${handle}`);
  return row.id;
}

/** A new recipient with a live page, signed up in a context of its own that is closed after. */
async function newRecipient(
  browser: Parameters<typeof secondOwner>[0],
  testInfo: Parameters<typeof secondOwner>[1],
) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    reducedMotion: 'reduce',
  });
  try {
    const recipient = await signUpRecipient(await context.newPage(), testInfo);
    return { ...recipient, profileId: await profileIdOf(recipient.handle) };
  } finally {
    await context.close();
  }
}

/** A supporter's ₦2,000 tip, paid through the pretend provider. */
async function paidTip(handle: string, request: Page['request']) {
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: { handle, amountMinor: '200000', currency: 'NGN' },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { quoteId: quote.data.quoteId, payerDisplayLabel: 'A supporter' },
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
}

async function openPage(page: Page, handle: string) {
  await page.goto('/ops/pages');
  const main = page.getByRole('main');
  await main.getByLabel('Username').fill(handle);
  await main.getByRole('button', { name: 'Find page' }).click();
  return main.getByRole('region', { name: 'Who pays the fees' });
}

// @alone: a second person approves a money change, as ops-plan-fees.spec.ts does.
test('@alone staff set an account waiver with an end date; a second person approves; the user’s ops page shows TipMe pays until that date', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const { handle } = await newRecipient(browser, testInfo);
  await enrolOwner(page, testInfo);
  const second = await secondOwner(browser, testInfo);
  try {
    const end = await lagosDateIn(40);

    const card = await openPage(page, handle);
    await expect(card.getByTestId('fee-waiver-tip')).toHaveText(
      'Tip fee: Follows the global setting (now: Account pays)',
    );
    await expect(card.getByTestId('fee-waiver-withdrawal')).toHaveText(
      'Withdrawal fee: Follows the global setting (now: 2 free a day, then account)',
    );
    await expect(card).toContainText('Fee income given up');
    await expect(card).toContainText('Cash paid by TipMe');

    await card.getByRole('button', { name: 'Change the tip fee…' }).click();
    const form = card.locator('form');
    await form.getByRole('radio', { name: /TipMe pays/ }).check();
    await form.getByLabel('Last day (optional)').fill(end.date);
    // A short reason is refused on the screen, before anything is asked.
    await form.getByLabel('Reason').fill('Too short');
    await form.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      form.getByText('Please write a reason of at least 10 characters.'),
    ).toBeVisible();
    await form.getByLabel('Reason').fill('Launch partner, TipMe covers fees');
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      card.getByText('Waiting for a second person', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    // Nothing changed yet.
    await expect(card.getByTestId('fee-waiver-tip')).toHaveText(
      'Tip fee: Follows the global setting (now: Account pays)',
    );

    await second.page.goto('/ops/approvals');
    const request = second.page.getByRole('article').filter({
      hasText: `TipMe pays the tip fee for @${handle} ${end.untilWithYear}`,
    });
    await expect(request).toBeVisible();
    await request.getByRole('button', { name: 'Approve…' }).click();
    await request.getByLabel('Authenticator code').fill(await codeFor(second));
    await request.getByRole('button', { name: 'Approve and run' }).click();
    await expect(request).toHaveCount(0);

    const after = await openPage(page, handle);
    await expect(after.getByTestId('fee-waiver-tip')).toHaveText(
      `Tip fee: TipMe pays · ${end.until}`,
    );
    await expect(after.getByTestId('fee-waiver-withdrawal')).toHaveText(
      'Withdrawal fee: Follows the global setting (now: 2 free a day, then account)',
    );
    await expectAccessible(page);
  } finally {
    await second.context.close();
  }
});

test('the grid shows the carried-over business rule and the paused label', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await enrolOwner(page, testInfo);
  // TipMe's balance is low: the API says so, and the screen must show it (spec §5).
  await page.route('**/v1/ops/fee-waivers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.data.tipWaiversPaused = true;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/ops/plan-fees');
  const main = page.getByRole('main');
  const grid = main.getByRole('region', { name: 'Who pays the fees' });
  await expect(grid).toBeVisible();
  const row = (name: string) =>
    grid
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name }) });

  // The migration carried the old business payout switch over as the business withdrawal rule.
  // Off in this stack, so the business pays; that row only ends a waiver, so it is in no list.
  await expect(row('Businesses').getByRole('cell').nth(0)).toHaveText('—');
  await expect(row('Businesses').getByRole('cell').nth(1)).toHaveText(
    'Account pays',
  );
  await expect(row('Individuals').getByRole('cell').nth(0)).toHaveText(
    'Account pays',
  );
  await expect(row('Individuals').getByRole('cell').nth(1)).toHaveText(
    '2 free a day, then account',
  );
  await expect(row('Giving (not live)')).toBeVisible();
  await expect(row('Individuals').getByRole('cell').nth(2)).toContainText(
    'Fee income given up',
  );
  await expect(row('Individuals').getByRole('cell').nth(2)).toContainText(
    'Cash paid by TipMe',
  );
  await expect(
    grid.getByRole('columnheader', { name: 'Tip fee · Paused (low balance)' }),
  ).toBeVisible();
  await expect(grid.getByTestId('fee-waivers-paused')).toBeVisible();
  await expectAccessible(page);
});

test('a kind-wide TipMe pays change asks to confirm the live cost, and again when it moved', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await enrolOwner(page, testInfo);
  // Every POST is answered here: a kind-wide rule must never reach the shared stack.
  const sent: Record<string, unknown>[] = [];
  await page.route('**/v1/ops/fee-waivers', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (sent.length === 1)
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'FEE_WAIVER_CONFIRM_REQUIRED',
            reason: 'confirm_cost',
            costEstimateMinor: '1235000',
            message: 'Confirm the cost.',
          },
        },
      });
    if (sent.length === 2)
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'FEE_WAIVER_CONFIRM_REQUIRED',
            reason: 'estimate_moved',
            costEstimateMinor: '1300000',
            message: 'Confirm the cost.',
          },
        },
      });
    return route.fulfill({
      status: 202,
      json: { data: { requestId: randomUUID(), repeat: false } },
    });
  });
  await page.goto('/ops/plan-fees');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Change…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change who pays' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Who it’s for').selectOption('individual');
  await dialog.getByLabel('Fee', { exact: true }).selectOption('withdrawal');
  await dialog.getByRole('radio', { name: /TipMe pays/ }).check();
  const end = await lagosDateIn(20);
  await dialog.getByLabel('Last day (optional)').fill(end.date);
  await dialog.getByLabel('Reason').fill('December promotion for everyone');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Ask for approval' }).click();

  await expect(
    dialog.getByText(
      'TipMe would pay about ₦12,350 a month, from the last 30 days’ fees. Tick the box to confirm it.',
    ),
  ).toBeVisible();
  const confirm = dialog.getByLabel(/I confirm TipMe pays about ₦12,350/);
  await expect(confirm).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    dialog.getByText('Tick the box to confirm the cost.'),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  await confirm.check();
  await dialog.getByRole('button', { name: 'Ask for approval' }).click();

  await expect(
    dialog.getByText(
      'The estimate changed to ₦13,000 since you opened this. Check it and confirm again.',
    ),
  ).toBeVisible();
  const again = dialog.getByLabel(/I confirm TipMe pays about ₦13,000/);
  await expect(again).not.toBeChecked();
  await again.check();
  await dialog.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    main.getByText('Waiting for a second person', { exact: true }).first(),
  ).toBeVisible();

  expect(sent[0]).toEqual({
    scope: 'kind',
    kind: 'individual',
    fee: 'withdrawal',
    payer: 'tipme',
    endsAt: end.endsAt,
    reason: 'December promotion for everyone',
  });
  expect(sent[1]).toMatchObject({
    confirmCost: true,
    costEstimateMinor: '1235000',
  });
  expect(sent[2]).toMatchObject({
    confirmCost: true,
    costEstimateMinor: '1300000',
    endsAt: end.endsAt,
  });
  // UTC Z strings only (the API takes no offset).
  expect(String(sent[2]?.endsAt)).toMatch(/Z$/);
});

test('the waivers list shows who set and approved it, with both cost figures', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { handle, profileId } = await newRecipient(browser, testInfo);
  const { email } = await enrolOwner(page, testInfo);
  const approverEmail = identity(testInfo).email.replace('kemi@', 'tunde@');
  await grantOwner(approverEmail);
  const setBy = await userIdOf(email);
  const approvedBy = await userIdOf(approverEmail);
  const end = await lagosDateIn(30);
  const ends = await lagosDateIn(10);
  // Set up as an approved change would leave it: the rule, and its upcoming end.
  await withDatabase(async (db, ops) => {
    await ops.setFeeWaiver(db, {
      scope: 'account',
      kind: 'individual',
      profileId,
      fee: 'tip',
      payer: 'tipme',
      endsAt: end.endsAt,
      staffUserId: setBy,
      approvedBy,
      reason: 'Launch partner for the waivers list',
      now: new Date(),
    });
    await ops.setFeeWaiver(db, {
      scope: 'account',
      kind: 'individual',
      profileId,
      fee: 'tip',
      payer: 'inherit',
      startsAt: (await domain()).endOfLagosDayIso(ends.date),
      staffUserId: setBy,
      approvedBy: null,
      reason: 'Ending the launch partner deal early',
      now: new Date(),
    });
  });
  // A waived tip: ₦2,000 at Free's 5%, so TipMe gave up ₦100 of fee income.
  await paidTip(handle, page.request);

  await page.goto('/ops/plan-fees/waivers');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Fee waivers', level: 1 }),
  ).toBeVisible();
  const inForce = main
    .getByRole('region', { name: 'In force', exact: true })
    .getByRole('row')
    .filter({ hasText: `@${handle}` });
  await expect(async () => {
    await page.reload();
    await expect(inForce).toContainText('Fee income given up ₦100', {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(inForce).toContainText('Tip fee');
  await expect(inForce).toContainText('TipMe pays');
  await expect(inForce).toContainText(end.until);
  await expect(inForce).toContainText(staffWord(setBy));
  await expect(inForce).toContainText(staffWord(approvedBy));
  await expect(inForce).toContainText(/Cash paid by TipMe ₦[\d,.]+/);
  await expect(inForce).toContainText('Launch partner for the waivers list');

  const upcoming = main
    .getByRole('region', { name: 'Upcoming', exact: true })
    .getByRole('row')
    .filter({ hasText: `@${handle}` });
  await expect(upcoming).toContainText('Ends the waiver');
  await expect(upcoming).toContainText('Alone (no second person)');
  await expectAccessible(page);
});
