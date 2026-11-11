import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInWithEmail, signUpRecipient } from './helpers';

// Paid Pro on the web (plan Tasks 7, 12, 13; ProPage and ProBadge boards). The e2e API runs with
// PRO_BILLING_ENABLED on and the pretend provider; the "off" and "no price" states answer the
// public price read here. The price always comes from the server (₦2,500 at launch).

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };
const PROVIDER = /bachs|paystack|flutterwave|stripe/i;

/** documentElement.clientWidth, never innerWidth (builder rules). */
const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

const priceBlock = (page: Page) =>
  page.getByRole('region', { name: 'TipMe Pro price' });

async function answerPrice(
  page: Page,
  answer: { billingOn: boolean } | 'none',
) {
  await page.route('**/v1/pro/price', (route) =>
    answer === 'none'
      ? route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'PRO_PRICE_NOT_SET' } }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              amountMinor: '250000',
              currency: 'NGN',
              interval: 'month',
              billingOn: answer.billingOn,
            },
          }),
        }),
  );
}

for (const size of [PHONE, WIDE]) {
  test(`billing off at ${size.width}px: the server's price, coming soon to buy, and Ask for Pro`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await answerPrice(page, { billingOn: false });
    await page.goto('/pro');
    const block = priceBlock(page);
    await expect(block.getByText('₦2,500', { exact: true })).toBeVisible();
    await expect(
      block
        .getByRole('status')
        .filter({ hasText: 'Pro is coming soon to buy.' }),
    ).toBeVisible();
    await expect(
      block.getByRole('link', { name: 'Ask for Pro' }),
    ).toHaveAttribute(
      'href',
      'mailto:support@usetipme.xyz?subject=TipMe%20Pro',
    );
    await expect(page.getByRole('link', { name: /Get Pro/ })).toHaveCount(0);
    const main = page.locator('main');
    await expect(
      main.getByRole('heading', { level: 1, name: 'Grow your appreciation.' }),
    ).toBeVisible();
    await expect(main).not.toContainText(PROVIDER);
    expect(await fits(page)).toBe(true);
    await expectAccessible(page);
  });
}

test('only features not built yet say Coming; what Free keeps is listed', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await page.goto('/pro');
  const adds = page.getByRole('region', { name: 'What Pro adds' });
  for (const name of ['Repeat supporters', 'Early access'])
    await expect(
      adds.getByRole('listitem').filter({ hasText: name }),
      name,
    ).toContainText('Coming');
  // Built in the Pro train (#188): earnings, the recap, Campaigns and priority support.
  for (const name of [
    'QR studio',
    'Three username changes',
    'Earnings analytics',
    'Monthly recap',
    'Campaign links',
    'Results per link',
    'Priority support',
  ])
    await expect(
      adds.getByRole('listitem').filter({ hasText: name }),
      name,
    ).not.toContainText('Coming');
  const free = page.getByRole('region', {
    name: 'Free stays genuinely useful',
  });
  await expect(free.getByRole('listitem')).toHaveCount(9);
  await expect(free).toContainText('Withdrawals to your bank');
});

test('no price set: "Price coming soon" and no naira amount', async ({
  page,
}) => {
  await answerPrice(page, 'none');
  await page.goto('/pro');
  const block = priceBlock(page);
  await expect(block.getByText('Price coming soon')).toBeVisible();
  await expect(block).not.toContainText('₦');
  await expect(page.getByRole('link', { name: /Get Pro/ })).toHaveCount(0);
});

test('on a phone the buy key waits at the foot once the price block scrolls away', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/pro');
  const foot = page.getByRole('link', { name: 'Get Pro · ₦2,500 a month' });
  await expect(
    priceBlock(page).getByRole('link', { name: 'Get Pro' }),
  ).toBeVisible();
  await expect(foot).toBeHidden();
  await page
    .getByRole('heading', { name: 'Questions' })
    .scrollIntoViewIfNeeded();
  await expect(foot).toBeInViewport();
  expect(await fits(page)).toBe(true);
});

test('billing on: a signed-out visitor is sent to sign in and back to /pro, then to checkout', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize(WIDE);
  const who = await signUpRecipient(page, testInfo);

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/pro');
  await priceBlock(visitor).getByRole('link', { name: 'Get Pro' }).click();
  await visitor.waitForURL(/\/sign-in\?next=%2Fpro$/);
  await signInWithEmail(visitor, who.email, '/sign-in?next=%2Fpro');
  await visitor.waitForURL(/\/pro$/);
  await priceBlock(visitor).getByRole('button', { name: 'Get Pro' }).click();
  await visitor.waitForURL(/\/mock-checkout\/mock_pro_[0-9a-f-]{36}$/);
  await expect(
    visitor.locator('main').getByText('One month of TipMe Pro, paid to TipMe'),
  ).toBeVisible();
});

test('Settings Plan: buy by bank transfer, confirmed by the partner, then one month ahead by card', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  const { handle } = await signUpRecipient(page, testInfo);

  // Free, before: the server's price, the two ways to pay, and the public page without a badge.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await expect(visitor.locator('#profile-name')).toBeVisible();
  await expect(visitor.locator('.tm-pro-badge')).toHaveCount(0);

  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await expect(plan).toContainText('Your page is on the Free plan.');
  await expect(plan).toContainText('₦2,500 a month');
  await expect(plan).toContainText('card or bank transfer');
  await expect(plan).not.toContainText(PROVIDER);
  await expectAccessible(page);

  // Hold the purchase's status until the "confirming" step has been seen.
  let hold = true;
  await page.route('**/v1/me/pro/purchases/*', async (route) => {
    if (!hold) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data.status = 'COLLECTING';
    await route.fulfill({ response, json: body });
  });

  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await expect(plan).toContainText('₦2,500 for one month of Pro');
  await plan.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pro_/);
  await page.getByRole('button', { name: /Pay by bank transfer/ }).click();
  await page.waitForURL(/\/dashboard\/settings/);
  const confirming = plan
    .getByRole('status')
    .filter({ hasText: 'We’re confirming your payment' });
  await expect(confirming).toBeVisible();
  // The redirect alone never says paid.
  await expect(plan).not.toContainText('Payment confirmed');
  await expectAccessible(page);
  hold = false;
  await expect(
    plan.getByRole('status').filter({ hasText: 'Payment confirmed' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText(/You’re on Pro, paid until \d{1,2} \w{3}/);
  await expect(plan.locator('.tm-pro-badge')).toBeVisible();

  // One month ahead, at most.
  await expect(plan).toContainText('You can pay one month ahead.');
  await plan
    .getByRole('button', { name: 'Pay for next month · ₦2,500' })
    .click();
  await plan.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pro_/);
  await page.getByRole('button', { name: /Pay by card/ }).click();
  await page.waitForURL(/\/dashboard\/settings/);
  await expect(
    plan.getByRole('status').filter({ hasText: 'Payment confirmed' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText(
    /Next month is paid: Pro until \d{1,2} \w{3}/,
  );
  await expect(
    plan.getByRole('button', { name: /Pay for next month/ }),
  ).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);

  // The dashboard's page card: the badge, and when it is paid until.
  await page.setViewportSize(WIDE);
  await page.goto('/dashboard');
  const card = page.locator('.page-card');
  await expect(card.locator('.tm-pro-badge')).toHaveText('Pro');
  await expect(card).toContainText(/Pro, paid until \d{1,2} \w{3}/);
  await expect(card.getByRole('link', { name: 'Manage' })).toHaveAttribute(
    'href',
    '/dashboard/settings#plan',
  );

  // The public page: a badge named as a paid plan, whose note says it isn't a check.
  for (const size of [PHONE, WIDE]) {
    await visitor.setViewportSize(size);
    const badge = visitor.getByRole('button', {
      name: 'TipMe Pro, a paid plan',
    });
    await expect(async () => {
      await visitor.goto(`/@${handle}`);
      await expect(badge).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('aria-expanded', 'false');
    const box = await badge.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await badge.click();
    await expect(badge).toHaveAttribute('aria-expanded', 'true');
    const note = visitor
      .locator('.profile-identity')
      .getByText(
        'TipMe Pro is a paid plan. It doesn’t mean TipMe checked who runs this page.',
      );
    await expect(note).toBeVisible();
    await expect(
      visitor
        .locator('.profile-identity')
        .getByRole('link', { name: 'About Pro' }),
    ).toHaveAttribute('href', '/pro');
    // Never "✓ Verified business": no such words, no tick, and purple, not green.
    await expect(visitor.locator('.profile-identity')).not.toContainText(
      /verified/i,
    );
    const pill = visitor.locator('.profile-identity .tm-pro-badge');
    await expect(pill.locator('path[stroke]')).toHaveCount(0);
    const colour = await pill.evaluate(
      (node) => getComputedStyle(node).backgroundImage,
    );
    expect(colour).toMatch(/rgb\(122, 50, 249\)/);
    expect(await fits(visitor)).toBe(true);
    await expectAccessible(visitor);
  }

  // A Pro visitor on /pro sees their plan, not a buy key.
  await page.goto('/pro');
  await expect(priceBlock(page)).toContainText(
    /You’re on Pro · paid until \d{1,2} \w{3}/,
  );
  await expect(
    priceBlock(page).getByRole('link', { name: 'Manage' }),
  ).toHaveAttribute('href', '/dashboard/settings#plan');
});

test('a declined payment leaves the page on Free and says so', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await plan.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pro_/);
  await page.getByRole('button', { name: /Decline/ }).click();
  await page.waitForURL(/\/dashboard\/settings/);
  await expect(
    plan
      .getByRole('alert')
      .filter({ hasText: 'The payment didn’t go through' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText('Your page is on the Free plan.');
});

// Pay from balance and auto-renew (#189) are behind the server's flags, off on every copy and in the
// e2e API. With them off the plan screen offers neither; with them on (answered here, on top of the
// real plan read) it offers both, and sends exactly what the server expects.

type PlanPatch = Record<string, unknown>;

/** Answers `GET /v1/me/pro` with the real read plus `patch()` (read at each request). */
async function standInPlan(page: Page, patch: () => PlanPatch) {
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route('**/v1/me/pro', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data = { ...body.data, ...patch() };
    await route.fulfill({ response, json: body });
  });
}

function purchase(status: string) {
  return {
    purchaseId: '6f1c7a52-1d1f-4a55-9a43-2f2b6c0e7d11',
    status,
    amountMinor: '250000',
    currency: 'NGN',
    checkoutUrl: null,
    expiresAt: null,
    paidAt: status === 'PAID' ? new Date().toISOString() : null,
  };
}

const refusal = (code: string) => ({
  status: 409,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code } }),
});

test('flags off: the plan offers no balance payment and no auto-renew', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await expect(
    plan.getByRole('button', { name: 'Continue to payment' }),
  ).toBeVisible();
  await expect(
    plan.getByRole('button', { name: /from your balance/ }),
  ).toHaveCount(0);
  await expect(plan.getByRole('checkbox')).toHaveCount(0);
  await expect(plan).not.toContainText(/auto-renew|automatically/i);
});

test('balance on: refusals are said plainly, then paying from the balance confirms Pro', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize(PHONE);
  await signUpRecipient(page, testInfo, { live: false });
  let paid = false;
  const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await standInPlan(page, () =>
    paid
      ? {
          plan: 'pro',
          source: 'paid',
          current: {
            startsAt: new Date().toISOString(),
            endsAt: end,
            graceEndsAt: end,
            paidBy: 'balance',
          },
          methods: ['card', 'balance'],
        }
      : { methods: ['card', 'balance'] },
  );
  const answers = [
    refusal('INSUFFICIENT_BALANCE'),
    refusal('PRO_BALANCE_REFUSED'),
  ];
  const sent: unknown[] = [];
  await page.route('**/v1/me/pro/purchases', async (route) => {
    sent.push(route.request().postDataJSON());
    const next = answers.shift();
    if (next) return route.fulfill(next);
    paid = true;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: purchase('PAID') }),
    });
  });

  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await expect(plan).toContainText('from your TipMe balance');
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  const fromBalance = plan.getByRole('button', {
    name: 'Pay ₦2,500 from your balance',
  });
  await fromBalance.click();
  await expect(plan.getByRole('alert')).toContainText(
    'Your balance is less than ₦2,500.',
  );
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await fromBalance.click();
  await expect(plan.getByRole('alert')).toContainText(
    'Our payment partner couldn’t take this from your balance. Nothing was taken.',
  );
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await fromBalance.click();
  await expect(
    plan.getByRole('status').filter({ hasText: 'Payment confirmed' }),
  ).toBeVisible();
  await expect(plan).toContainText(/You’re on Pro, paid until \d{1,2} \w{3}/);
  expect(sent).toEqual([
    { expectedAmountMinor: '250000', method: 'balance' },
    { expectedAmountMinor: '250000', method: 'balance' },
    { expectedAmountMinor: '250000', method: 'balance' },
  ]);
  await expect(plan).not.toContainText(PROVIDER);
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);
});

test('balance on: an unanswered balance payment says it is being checked until it is paid', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await signUpRecipient(page, testInfo, { live: false });
  await standInPlan(page, () => ({ methods: ['card', 'balance'] }));
  let status = 'UNKNOWN';
  await page.route('**/v1/me/pro/purchases', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: purchase('UNKNOWN') }),
    }),
  );
  await page.route('**/v1/me/pro/purchases/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: purchase(status) }),
    }),
  );
  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  await plan
    .getByRole('button', { name: 'Pay ₦2,500 from your balance' })
    .click();
  await expect(
    plan.getByRole('status').filter({ hasText: 'We’re checking this payment' }),
  ).toBeVisible();
  await expect(plan).not.toContainText('Payment confirmed');
  status = 'PAID';
  await expect(
    plan.getByRole('status').filter({ hasText: 'Payment confirmed' }),
  ).toBeVisible({ timeout: 20_000 });
});

test('auto-renew available: the tick sends autoRenew, and a missing email is said plainly', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await standInPlan(page, () => ({
    autoRenew: { available: true, on: false },
  }));
  const sent: unknown[] = [];
  await page.route('**/v1/me/pro/purchases', async (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill(refusal('PRO_AUTO_RENEW_NEEDS_EMAIL'));
  });
  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await plan.getByRole('button', { name: 'Get Pro · ₦2,500 a month' }).click();
  const tick = plan.getByRole('checkbox', {
    name: 'Renew automatically on this card',
  });
  await expect(tick).not.toBeChecked();
  await tick.check();
  await plan.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(plan.getByRole('alert')).toContainText(
    'To renew automatically, add an email address to your account first.',
  );
  expect(sent).toEqual([{ expectedAmountMinor: '250000', autoRenew: true }]);
  await expectAccessible(page);
});

test('auto-renew on: the plan says so, and Turn off auto-renew turns it off', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  let on = true;
  const end = new Date(Date.now() + 20 * 86_400_000).toISOString();
  await standInPlan(page, () => ({
    plan: 'pro',
    source: 'paid',
    current: {
      startsAt: new Date().toISOString(),
      endsAt: end,
      graceEndsAt: end,
      paidBy: 'saved_card',
    },
    // Shown whenever it is on, even with the flag off (#189).
    autoRenew: { available: false, on },
  }));
  const off = page.waitForRequest(
    (request) =>
      request.url().endsWith('/v1/me/pro/auto-renew/off') &&
      request.method() === 'POST',
  );
  await page.goto('/dashboard/settings#plan');
  const plan = page.locator('#pro');
  await expect(plan).toContainText('Renews automatically on your saved card.');
  await plan.getByRole('button', { name: 'Turn off auto-renew' }).click();
  await off;
  on = false;
  await expect(
    plan.getByRole('status').filter({ hasText: 'Auto-renew is off' }),
  ).toBeVisible();
  await expect(
    plan.getByRole('button', { name: 'Turn off auto-renew' }),
  ).toHaveCount(0);
  await expect(plan).not.toContainText('Renews automatically');
  await expectAccessible(page);
});
