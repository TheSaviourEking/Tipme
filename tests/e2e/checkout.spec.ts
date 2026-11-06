import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { enrolOwner } from './ops-helpers';
import { CONNECTION_COPY } from '../../apps/web/src/lib/connection-copy';

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
  await page.getByRole('radio', { name: amount }).click();
  // The optional details sit behind one disclosure.
  if (purpose || remember)
    await page.getByText('Add a message, reason or your name').click();
  if (purpose)
    await page
      .getByLabel('What is this tip for? (optional)')
      .selectOption(purpose);
  if (remember) await page.getByLabel('Remember my tips on this phone').check();
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pay_/);
  await expect(
    page.getByText('Test payment provider · no real money'),
  ).toBeVisible();
  await page.getByRole('button', { name: outcome }).click();
  await page.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}
const paidHeading = (page: Page) =>
  page.getByRole('heading', { name: /^.+ got your thanks\.$/ });

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

test('the tip form shows the amount and nothing about fees or what the person receives', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  const panel = page.locator('[data-tip-panel]');
  await expect(page.getByRole('button', { name: /^Tip ₦2,000/ })).toBeEnabled();
  await expect(page.locator('.tip-breakdown')).toHaveCount(0);
  await expect(panel.getByText(/you pay ngn|total|receive|fee/i)).toHaveCount(
    0,
  );
  expect((await panel.ariaSnapshot()).toLowerCase()).not.toMatch(
    /total to pay|receives|\bfees?\b/,
  );
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

  // A recognition key from an earlier tip elsewhere goes too (repeat supporters).
  await page.evaluate(() =>
    localStorage.setItem(
      'tipme.supporters.v1',
      JSON.stringify({ v: 1, keys: { tobi: 'A'.repeat(43) } }),
    ),
  );
  await page
    .getByRole('button', { name: 'Forget my tips and keys on this phone' })
    .click();
  await expect(page.getByText(/This phone no longer remembers/)).toBeVisible();
  expect(
    await page.evaluate(() => [
      localStorage.getItem('tipme.myTips.v1'),
      localStorage.getItem('tipme.supporters.v1'),
    ]),
  ).toEqual([null, null]);
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
    page.getByRole('heading', { name: 'This payment didn’t go through' }),
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
    page.getByRole('heading', { name: 'This payment didn’t go through' }),
  ).toBeVisible();
  const crafted = `/tip/${tipId}?status=succeeded&paid=true&outcome=success&state=PAID`;
  await page.goto(crafted);
  await expect(
    page.getByRole('heading', { name: 'This payment didn’t go through' }),
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
    has: page.getByRole('heading', { name: 'Checking your payment' }),
  });
  await expect(live).toBeVisible();
  await expectAccessible(page);
});

/** Holds the real status response at one state, for this page only. */
async function holdStatus(page: Page, state: string) {
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, state, completedAt: null } },
    });
  });
}

test('while checking, one quiet pulse and no celebration', async ({ page }) => {
  await holdStatus(page, 'waiting');
  await tip(page, { handle: 'ada' });
  await expect(page.getByText('Checking your payment')).toBeVisible();
  await expect(page.locator('[data-pulse]')).toHaveCount(1);
  await expect(page.locator('.tm-celebration')).toHaveCount(0);
  await expect(paidHeading(page)).toHaveCount(0);
});

test('once confirmed, one moment and then the receipt', async ({ page }) => {
  await tip(page, { handle: 'ada' });
  const live = page.getByRole('status').filter({
    has: page.getByRole('heading', { name: 'Ada Okafor got your thanks.' }),
  });
  await expect(live).toBeVisible();
  await expect(page.locator('.tm-celebration')).toHaveCount(1);
  await expect(page.locator('[data-pulse]')).toHaveCount(0);
  const receipt = page.getByRole('region', { name: 'Your receipt' });
  await expect(receipt.getByText('Your tip', { exact: true })).toBeVisible();
  await expect(receipt.getByText('₦2,000')).toBeVisible();
  await expect(receipt.getByText(/^[0-9A-Z_-]{6}$/)).toBeVisible();
  // Supporters see nothing about what the person receives (owner decision, 2 Nov 2026).
  await expect(receipt.getByText(/receives/i)).toHaveCount(0);
  await expect(page.getByText(/payment provider/i)).toHaveCount(0);
  await expectAccessible(page);
});

test('the whole page name leads the thank-you and the failure, not its first word', async ({
  page,
}) => {
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          recipient: { ...body.data.recipient, displayName: 'Lagos Bakery' },
        },
      },
    });
  });
  await tip(page, { handle: 'ada' });
  await expect(
    page.getByRole('heading', { name: 'Lagos Bakery got your thanks.' }),
  ).toBeVisible();
  await page.unroute('**/v1/tips/*/status');
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          state: 'declined',
          recipient: { ...body.data.recipient, displayName: 'Lagos Bakery' },
        },
      },
    });
  });
  await page.reload();
  await expect(
    page.getByText('Your tip to Lagos Bakery wasn’t sent.'),
  ).toBeVisible();
});

test('one status region stays mounted from checking to confirmed, so the change is announced', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    calls += 1;
    await route.fulfill({
      response,
      json: {
        data:
          calls === 1
            ? {
                ...body.data,
                state: 'waiting',
                completedAt: null,
                reference: null,
              }
            : body.data,
      },
    });
  });
  await tip(page, { handle: 'ada' });
  const live = page.locator('[data-status-live]');
  await expect(page.getByText('Checking your payment')).toBeVisible();
  await expect(live).toHaveAttribute('role', 'status');
  await live.evaluate((el) => {
    (window as unknown as { __live: Element }).__live = el;
  });
  await expect(paidHeading(page)).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(
      () =>
        document.querySelector('[data-status-live]') ===
        (window as unknown as { __live: Element }).__live,
    ),
  ).toBe(true);
  await expect(live).toContainText('got your thanks.');
});

test('in forced colours the thank-you slab and receipt keep an edge', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await tip(page, { handle: 'ada' });
  await expect(paidHeading(page)).toBeVisible();
  for (const selector of [
    '.tip-thanks',
    '.tip-thanks__receipt',
    '.tip-thanks__initial',
    '.tip-thanks__tick',
  ])
    expect(
      await page
        .locator(selector)
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
      selector,
    ).not.toBe('none');
});

test('the reference on the receipt is what staff search finds the tip by', async ({
  page,
  browser,
}, testInfo) => {
  await tip(page, { handle: 'ada' });
  const reference =
    (await page
      .getByRole('region', { name: 'Your receipt' })
      .locator('dd')
      .last()
      .textContent()) ?? '';
  expect(reference).toMatch(/^[0-9A-Z_-]{6}$/);
  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.goto('/ops/search');
  await staff.getByLabel('Search').fill(reference);
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(staff.getByRole('status')).toHaveText('1 result.');
  await expect(staff.getByRole('heading', { name: 'Tips' })).toBeVisible();
});

test('with reduced motion the confirmed screen does not animate', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tip(page, { handle: 'ada' });
  await expect(paidHeading(page)).toBeVisible();
  // Reduced motion shortens every animation to a hundredth of a millisecond: one may still be
  // "running" for the frame it starts in, so what counts is any that is long enough to be seen.
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' &&
          Number(animation.effect?.getComputedTiming().duration ?? 0) > 1,
      )
      .map((animation) => animation.id || animation.constructor.name),
  );
  expect(running).toEqual([]);
});

test('didn’t go through says nothing was sent and offers one next step', async ({
  page,
}) => {
  await tip(page, { handle: 'ada', outcome: /^Decline/ });
  await expect(
    page.getByText('Your tip to Ada Okafor wasn’t sent.', { exact: false }),
  ).toBeVisible();
  const again = page.getByRole('link', { name: 'Try again' });
  await expect(again).toHaveCount(1);
  await expect(again).toHaveAttribute('href', '/@ada');
  await expect(page.locator('.tm-celebration')).toHaveCount(0);
});

test('the thank-you and receipt fit a phone @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tip(page, { handle: 'ada' });
  await expect(
    page.getByRole('heading', { name: 'Ada Okafor got your thanks.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Your receipt' }),
  ).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  const done = page.getByRole('link', { name: 'Done' });
  const box = (await done.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
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
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.getByRole('button', { name: /^Tip ₦/ }).dblclick();
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
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  expect(await fitsViewport(page)).toBe(true);
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
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

test('a receipt that loses the API while waiting shows the Connection lost slip, and recovers', async ({
  page,
}) => {
  // "No reply": paid, but the provider never tells TipMe, so the receipt keeps checking.
  await tip(page, { outcome: /^No reply/ });
  await expect(page.locator('.tip-status-card')).toBeVisible();
  await page.route('**/v1/tips/*/status', (route) => route.abort());
  const slip = page.locator('.tm-slip').filter({ hasText: 'Connection lost' });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText(CONNECTION_COPY.receiptNoAnswer);
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(page.locator('.tm-notice')).toHaveCount(0);
  await expectAccessible(page);
  await page.unroute('**/v1/tips/*/status');
  await expect(slip).toHaveCount(0);
});

test('offline on the receipt: it checks again at once on reconnect', async ({
  page,
  context,
}) => {
  // The receipt must still be checking after the wait below, and TipMe soon learns a "No reply"
  // tip was paid: so this receipt is always told the tip is still being checked.
  await page.route('**/v1/tips/*/status', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data?: { state?: string } };
    if (body.data) body.data.state = 'waiting';
    return route.fulfill({ response, json: body });
  });
  await tip(page, { outcome: /^No reply/ });
  await expect(page.locator('.tip-status-card')).toBeVisible();
  // Past the first ten checks the receipt waits 2 s between them, so a check within a moment of
  // reconnecting is the reconnect's own.
  await page.waitForTimeout(11_000);
  await context.setOffline(true);
  const slip = page.locator('.tm-slip').filter({ hasText: 'Connection lost' });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText(CONNECTION_COPY.receiptOffline);
  await page.waitForTimeout(2500);
  let checks = 0;
  page.on('request', (request) => {
    if (/\/v1\/tips\/[^/]+\/status/.test(request.url())) checks += 1;
  });
  await context.setOffline(false);
  // Well inside the 2 s the receipt would otherwise wait.
  await expect.poll(() => checks, { timeout: 800 }).toBeGreaterThan(0);
  await expect(slip).toHaveCount(0);
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
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  // The Pay button comes from the page's own fetch: wait for it, so the tip expires only after the
  // page has loaded as payable, and this tests a stale page rather than racing that fetch.
  const pay = page.getByRole('button', { name: /^Pay/ });
  await expect(pay).toBeVisible();
  const reference = new URL(page.url()).pathname.split('/')[2] ?? '';
  // The page reads the payment as it loads: on a busy machine, expiring it first hides this button.
  await expect(page.getByRole('button', { name: /^Pay/ })).toBeVisible();
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
  // A page still open can't pay it, and says why.
  await pay.click();
  const expired = page.getByText(
    'This payment has expired and can no longer be paid.',
  );
  await expect(expired).toBeVisible();
  // Nor can a fresh look at it: the same words, and no Pay button.
  await page.reload();
  await expect(expired).toBeVisible();
  await expect(pay).toHaveCount(0);
});

test('fix: going back from the provider page leaves the form usable', async ({
  page,
}) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await page.goBack();
  // What is shown matches what would be sent: the page starts again on its NGN 2,000, with no
  // price carried over from the earlier visit. Nothing is quoted until the person taps Tip.
  await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeChecked();
  await expect(
    page.getByRole('button', { name: /^Tip ₦2,000$/ }),
  ).toBeEnabled();
});

async function chooseTobi2000(page: Page) {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
}

test('minor: a failed refresh after an expired quote is reported as a failure', async ({
  page,
}) => {
  await chooseTobi2000(page);
  await page.route('**/v1/tip-intents', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'QUOTE_EXPIRED', message: 'x', reference: 'r' } },
    }),
  );
  // The tap's own quote works; the refresh after the refusal doesn't.
  let quotes = 0;
  await page.route('**/v1/tip-quotes', (route) =>
    (quotes += 1) === 1 ? route.fallback() : route.abort(),
  );
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await expect(
    page.locator('.tip-quote').getByText(CONNECTION_COPY.tipDropped),
  ).toBeVisible();
  await expect(page.getByText(/Please tap Tip again/)).toHaveCount(0);
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
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await expect(page.getByRole('radio', { name: '5,000 NGN' })).toBeDisabled();
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
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
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
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await expect(
    page.getByText('The test provider is unavailable. Please try again.'),
  ).toBeVisible();
  // A page-level error slip: no stamp, announced as an alert.
  const slip = page
    .locator('.tm-slip')
    .filter({ hasText: 'Payment unavailable' });
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(slip.locator('.tm-slip__stamp')).toHaveCount(0);
  await page.unroute('**/v1/mock-provider/checkout/*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('NGN 2,000.00')).toBeVisible();
});
