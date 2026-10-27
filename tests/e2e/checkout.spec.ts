import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(wcag)
    .analyze();
  expect(
    violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map((node) => node.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}
const fitsViewport = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Profile → quote → Tip → pretend provider → outcome. Returns the tip id. */
async function tip(
  page: Page,
  {
    handle = 'tobi',
    amount = '2,000 NGN',
    remember = false,
    purpose,
    outcome = /^Pay/,
  }: {
    handle?: string;
    amount?: string;
    remember?: boolean;
    purpose?: string;
    outcome?: RegExp;
  } = {},
) {
  await page.goto(`/@${handle}`);
  await page.getByRole('radio', { name: amount }).check();
  if (purpose)
    await page
      .getByLabel('What is this tip for? (optional)')
      .selectOption(purpose);
  await expect(page.getByText(/You pay NGN [\d,]+\.\d\d/)).toBeVisible();
  if (remember) {
    // The profile keeps the optional extras behind a disclosure.
    await page.getByText('Add your name or remember tips').click();
    await page.getByLabel('Remember my tips on this phone').check();
  }
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pay_/);
  await expect(
    page.getByText('Test payment provider · no real money'),
  ).toBeVisible();
  await page.getByRole('button', { name: outcome }).click();
  await page.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}
const paidHeading = (page: Page) =>
  page.getByRole('heading', { name: /^Paid\. .+ got your thanks\.$/ });

test('a supporter can attach a structured purpose to a tip', async ({
  page,
}) => {
  const intentRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/v1/tip-intents') && request.method() === 'POST',
  );
  await tip(page, { handle: 'ada', purpose: 'great_service' });
  expect((await intentRequest).postDataJSON()).toMatchObject({
    purpose: 'great_service',
  });
  await expect(paidHeading(page)).toBeVisible();
});

test('the tip form shows only the payer total before continuing', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText('You pay NGN 2,000.00')).toBeVisible();
  await expect(page.locator('.tip-breakdown')).toHaveCount(0);
  await expect(
    page
      .locator('.tip-quote')
      .getByText(/TipMe fee|receives NGN|Fees from policy/),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Tip NGN 2,000\.00/ }),
  ).toBeEnabled();
  await expectAccessible(page);
});

test('an opted-in supporter is celebrated after each confirmed tip', async ({
  page,
}) => {
  await tip(page, { remember: true });
  await expect(paidHeading(page)).toBeVisible();
  // The receipt token has left the address bar.
  expect(page.url()).not.toContain('#t=');
  await expect(
    page.getByText(
      "That's your first tip. You've made someone's day. We see you.",
    ),
  ).toBeVisible();
  await expectAccessible(page);

  await tip(page, { handle: 'ada', remember: true });
  await expect(paidHeading(page)).toBeVisible();
  await expect(
    page.getByText(
      "That's your 2nd tip. You've made 2 people's day. We see you.",
    ),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tipme.myTips.v1') ?? 'null'),
  );
  expect(stored.v).toBe(1);
  expect(stored.tips).toHaveLength(2);
  for (const entry of stored.tips)
    expect(Object.keys(entry).sort()).toEqual(['at', 'handle', 'id']);

  await page
    .getByRole('button', { name: 'Forget my tips on this phone' })
    .click();
  await expect(page.getByText(/This phone no longer remembers/)).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('tipme.myTips.v1')),
  ).toBeNull();
});

test('a supporter who did not opt in is never remembered', async ({ page }) => {
  await tip(page);
  await expect(paidHeading(page)).toBeVisible();
  await expect(page.locator('.tip-recognition')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('a declined payment says so and links back to try again', async ({
  page,
}) => {
  await tip(page, { outcome: /^Decline/ });
  await expect(
    page.getByRole('heading', { name: 'The payment was declined' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute(
    'href',
    '/@tobi',
  );
  await expectAccessible(page);
});

test('a slow payment waits, then shows paid', async ({ page }) => {
  await tip(page, { outcome: /^Slow payment/ });
  await expect(paidHeading(page)).toBeVisible({ timeout: 15_000 });
});

test('a payment the provider never reports is found by reconciliation', async ({
  page,
}) => {
  // "Waiting" can be too brief to observe here (the worker checks every 500 ms); that the tip
  // stays unpaid until reconciliation is proven in tests/integration/checkout-api.test.mjs.
  await tip(page, { outcome: /^No reply/ });
  await expect(paidHeading(page)).toBeVisible({ timeout: 15_000 });
});

test('a crafted "success" address never changes what the receipt says', async ({
  page,
}) => {
  // PRD: "no wallet credit based solely on frontend callbacks or return URLs". The page reads
  // the verdict from the API only, so claiming success in the address changes nothing.
  const tipId = await tip(page, { outcome: /^Decline/ });
  await expect(
    page.getByRole('heading', { name: 'The payment was declined' }),
  ).toBeVisible();
  const crafted = `/tip/${tipId}?status=succeeded&paid=true&outcome=success&state=PAID`;
  await page.goto(crafted);
  await expect(
    page.getByRole('heading', { name: 'The payment was declined' }),
  ).toBeVisible();
  await expect(paidHeading(page)).toHaveCount(0);
});

test('the waiting screen is announced and accessible', async ({ page }) => {
  // UI-state check: the real status response is held at "waiting" for this page only.
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, state: 'waiting', completedAt: null } },
    });
  });
  await tip(page);
  const live = page.getByRole('status').filter({
    has: page.getByRole('heading', { name: 'Waiting for confirmation…' }),
  });
  await expect(live).toBeVisible();
  await expectAccessible(page);
});

test('a double tap on Tip creates one tip', async ({ page }) => {
  // Every intent request from this draft carries the same key, and the database holds one tip for it.
  const keys = new Set<string>();
  page.on('request', (request) => {
    if (
      request.url().endsWith('/v1/tip-intents') &&
      request.method() === 'POST'
    )
      keys.add(request.headers()['idempotency-key'] ?? '');
  });
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(
    page.getByText(/^Tobi receives NGN [\d,]+\.\d\d after fees$/),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Tip NGN/ }).dblclick();
  await page.waitForURL(/\/mock-checkout\//);
  expect(keys.size).toBe(1);
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  const database = await openTestDatabase();
  try {
    const { rows } = await database.pool.query(
      'SELECT count(*)::int AS n FROM payment_intents WHERE idempotency_key = $1',
      [[...keys][0]],
    );
    expect(rows[0].n).toBe(1);
  } finally {
    await database.close();
  }
});

test('the receipt survives a reload but needs its private link elsewhere', async ({
  page,
  browser,
}) => {
  const tipId = await tip(page);
  await expect(paidHeading(page)).toBeVisible();
  await page.reload();
  await expect(paidHeading(page)).toBeVisible();

  const fresh = await browser.newContext();
  const stranger = await fresh.newPage();
  await stranger.goto(`/tip/${tipId}`);
  await expect(
    stranger.getByRole('heading', { name: 'This receipt link is incomplete' }),
  ).toBeVisible();
  await expectAccessible(stranger);
  await fresh.close();
});

test('status and pretend provider pages reflow at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText(/receives NGN/)).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await expect(page.getByRole('button', { name: /^Pay/ })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await page.getByRole('button', { name: /^Pay/ }).click();
  await expect(paidHeading(page)).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  for (const route of ['/tip/00000000-0000-7000-8000-000000000000']) {
    await page.goto(route);
    expect(await fitsViewport(page), route).toBe(true);
  }
});

test('fix: an unreachable API on first load shows a recoverable error, not a skeleton', async ({
  page,
}) => {
  await tip(page);
  await expect(paidHeading(page)).toBeVisible();
  await page.route('**/v1/tips/*/status', (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'We can’t reach TipMe right now' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.unroute('**/v1/tips/*/status');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(paidHeading(page)).toBeVisible();
});

test('fix: every receipt says the payment was pretend', async ({ page }) => {
  await tip(page);
  await expect(paidHeading(page)).toBeVisible();
  await expect(
    page.getByText('Test payment · no real money moved'),
  ).toBeVisible();
});

test('fix: an expired tip is described honestly and cannot be paid afterwards', async ({
  page,
}) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText(/receives NGN/)).toBeVisible();
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  const reference = new URL(page.url()).pathname.split('/')[2] ?? '';
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  const { expireStaleTips } =
    await import('../../packages/database/dist/index.js');
  const database = await openTestDatabase();
  try {
    const { rows } = await database.pool.query(
      'SELECT id FROM payment_attempts WHERE provider_reference = $1',
      [reference],
    );
    // Only this tip: its quote is moved into the past, then expiry runs with a provider saying "pending".
    await database.pool.query(
      `UPDATE tip_quotes SET expires_at = now() - interval '1 hour'
         WHERE id = (SELECT i.quote_id FROM payment_intents i
                       JOIN payment_attempts a ON a.intent_id = i.id WHERE a.id = $1)`,
      [rows[0].id],
    );
    await expireStaleTips({
      db: database.db,
      provider: {
        name: 'mock',
        findPayment: async () => null,
        verifyTransaction: async () => ({
          status: 'pending',
          amountMinor: 0n,
          currency: 'NGN',
          feeMinor: 0n,
        }),
      },
      now: new Date(),
    });
  } finally {
    await database.close();
  }
  await page.getByRole('button', { name: /^Pay/ }).click();
  await expect(
    page.getByText('This payment has expired and can no longer be paid.'),
  ).toBeVisible();
});

test('fix: going back from the provider page leaves the form usable', async ({
  page,
}) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText(/receives NGN/)).toBeVisible();
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await page.goBack();
  // What is shown matches what would be sent: no restored choice without its quote.
  await expect(
    page.getByRole('radio', { name: '2,000 NGN' }),
  ).not.toBeChecked();
  await expect(page.getByRole('button', { name: /^Tip$/ })).toBeEnabled();
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText(/receives NGN/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Tip NGN 2,000\.00/ }),
  ).toBeEnabled();
});

async function chooseTobi2000(page: Page) {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(
    page.getByText(/^Tobi receives NGN [\d,]+\.\d\d after fees$/),
  ).toBeVisible();
}

test('minor: a failed price refresh is reported as a failure, not as refreshed', async ({
  page,
}) => {
  await chooseTobi2000(page);
  await page.route('**/v1/tip-intents', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'QUOTE_EXPIRED', message: 'x', reference: 'r' } },
    }),
  );
  await page.route('**/v1/tip-quotes', (route) => route.abort());
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await expect(
    page.getByText(
      'We couldn’t reach TipMe. Check your connection and try again.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/Your price was refreshed/)).toHaveCount(0);
});

test('minor: the draft cannot change while a tip is being started', async ({
  page,
}) => {
  await chooseTobi2000(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/v1/tip-intents', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await expect(page.getByRole('radio', { name: '1,000 NGN' })).toBeDisabled();
  await expect(page.getByLabel('Personal message (optional)')).toBeDisabled();
  release();
  await page.waitForURL(/\/mock-checkout\//);
});

test('minor: tipping works where crypto.randomUUID is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined });
  });
  await chooseTobi2000(page);
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
});

test('minor: the receipt token never travels through the provider', async ({
  page,
}) => {
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  await tip(page);
  await expect(paidHeading(page)).toBeVisible();
  expect(visited.some((url) => url.includes('#t='))).toBe(false);
  await page.reload();
  await expect(paidHeading(page)).toBeVisible();
});

test('minor: the pretend provider page can retry loading', async ({ page }) => {
  await chooseTobi2000(page);
  await page.route('**/v1/mock-provider/checkout/*', (route) =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await expect(
    page.getByText('The test provider is unavailable. Please try again.'),
  ).toBeVisible();
  await page.unroute('**/v1/mock-provider/checkout/*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('NGN 2,000.00')).toBeVisible();
});
