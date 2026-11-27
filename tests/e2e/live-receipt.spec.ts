import { expect, test, type Page, type Request } from '@playwright/test';
import { API_ORIGIN } from './stack';

// The tip receipt follows its tip over GET /v1/tips/:tipId/events (addendum §3.6) when the status
// read says live updates are on (this stack: LIVE_UPDATES_ENABLED). While connected it makes no
// timed reads; refused, it polls on nextCheckDelay exactly as with live updates off. The receipt's
// status token travels in the Authorization header only.

const STATUS = /\/v1\/tips\/[0-9a-f-]{36}\/status$/;
const EVENTS = /\/v1\/tips\/[0-9a-f-]{36}\/events$/;

interface Started {
  tipId: string;
  token: string;
  reference: string;
}

/**
 * A visitor starts a tip and reaches the pretend checkout, then opens the receipt without paying:
 * the tip waits until the test pays it. The token stays in this tab's session, as after a checkout.
 */
async function startTip(page: Page, handle = 'ada'): Promise<Started> {
  await page.goto(`/@${handle}`);
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  // The intent's answer, read as it passes (its body is gone once the page moves on).
  let created: { tipId: string; statusToken: string } | null = null;
  await page.route('**/v1/tip-intents', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      data?: { tipId: string; statusToken: string };
    };
    if (body.data) created = body.data;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await page.waitForURL(/\/mock-checkout\/mock_pay_/);
  await page.unroute('**/v1/tip-intents');
  const intent = created as { tipId: string; statusToken: string } | null;
  if (!intent) throw new Error('no tip intent answer');
  const reference = new URL(page.url()).pathname.split('/').pop() ?? '';
  return {
    tipId: intent.tipId,
    token: intent.statusToken,
    reference: decodeURIComponent(reference),
  };
}

/** The pretend provider pays it now: its signed webhooks reach the API, as a slow confirm would. */
async function pay(page: Page, reference: string) {
  const response = await page.request.post(
    `${API_ORIGIN}/v1/mock-provider/checkout/${encodeURIComponent(reference)}`,
    { data: { outcome: 'succeed' } },
  );
  expect(response.ok()).toBe(true);
}

/** Every status read the page makes, with its time. */
function recordReads(page: Page) {
  const reads: number[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && STATUS.test(request.url()))
      reads.push(Date.now());
  });
  return reads;
}

const receipt = (page: Page) => page.locator('[data-live]');
const paidHeading = (page: Page) =>
  page.getByRole('heading', { name: /^.+ got your tip\.$/ });

test('a receipt turns paid without polling while connected', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const tip = await startTip(page);
  const reads = recordReads(page);
  await page.goto(`/tip/${tip.tipId}`);
  await expect(
    page.getByRole('heading', { name: 'Checking your payment' }),
  ).toBeVisible();
  await expect(receipt(page)).toHaveAttribute('data-live', 'connected');
  // The stream's ready asks for one read (ruling L-R13); let it land.
  await page.waitForTimeout(1000);
  const atReady = reads.length;
  // Polling would read every second here (ten checks), then every 2 s: none while connected.
  await page.waitForTimeout(6000);
  expect(reads.length).toBe(atReady);
  await expect(receipt(page)).toHaveAttribute('data-live', 'connected');
  const paidAt = Date.now();
  await pay(page, tip.reference);
  await expect(paidHeading(page)).toBeVisible({ timeout: 5000 });
  expect(Date.now() - paidAt).toBeLessThan(5000);
  // One read on the signal. The pending webhook just before the paid one raises its own
  // tip.changed; when that read lands before the payment is booked, a second read follows.
  const afterPay = reads.length - atReady;
  expect(afterPay).toBeGreaterThanOrEqual(1);
  expect(afterPay).toBeLessThanOrEqual(2);
  // Paid is final: the receipt stops following (no stream, no reads).
  await expect(receipt(page)).toHaveAttribute('data-live', 'idle');
  const settled = reads.length;
  await page.waitForTimeout(3000);
  expect(reads.length).toBe(settled);
});

test('the receipt polls as today when the stream is refused', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const tip = await startTip(page);
  let streams = 0;
  await page.route(EVENTS, (route) => {
    streams += 1;
    return route.abort();
  });
  const reads = recordReads(page);
  const opened = Date.now();
  await page.goto(`/tip/${tip.tipId}`);
  await expect(
    page.getByRole('heading', { name: 'Checking your payment' }),
  ).toBeVisible();
  await page.waitForTimeout(12_000 - (Date.now() - opened));
  // nextCheckDelay: every second for the first ten checks, then every 2 s.
  expect(reads.length).toBeGreaterThanOrEqual(10);
  expect(streams).toBeGreaterThanOrEqual(1);
  await expect(receipt(page)).not.toHaveAttribute('data-live', 'connected');
  await page.unroute(EVENTS);
});

test('the token never appears in a request URL', async ({ page }) => {
  test.setTimeout(60_000);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const tip = await startTip(page);
  await page.goto(`/tip/${tip.tipId}`);
  await expect(receipt(page)).toHaveAttribute('data-live', 'connected');
  await pay(page, tip.reference);
  await expect(paidHeading(page)).toBeVisible({ timeout: 5000 });
  expect(tip.token.length).toBeGreaterThan(20);
  for (const request of requests)
    expect(request.url(), request.url()).not.toContain(tip.token);
  // It travels in the header, on the status reads and on the stream alike, never with a cookie.
  const stream = requests.find((request) => EVENTS.test(request.url()));
  expect(stream).toBeDefined();
  const headers = await stream!.allHeaders();
  expect(headers['authorization']).toBe(`Bearer ${tip.token}`);
  expect(headers['cookie']).toBeUndefined();
  const status = requests.find((request) => STATUS.test(request.url()));
  expect((await status!.allHeaders())['authorization']).toBe(
    `Bearer ${tip.token}`,
  );
});
