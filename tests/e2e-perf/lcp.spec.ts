import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_ORIGIN, E2E_DATABASE_URL, WEB_ORIGIN } from '../e2e/stack';

// Lab only: simulated mid-range phone (4x CPU slowdown) on a "Fast 3G"-like link.
// Each sample gets a fresh browser context (empty HTTP cache, same sign-in), so a cold and a warm
// load are never mixed. Logs the LCP element so the number can be tied to a picture or a heading.
type Sample = { ms: number; element: string };
// The suite defaults to reduced motion; the sample runs the cover's animation (see test.use below).
const SAMPLE_MOTION = 'no-preference' as const;
const elements: Record<string, string[]> = {};

async function lcp(
  browser: import('@playwright/test').Browser,
  storageState: Awaited<
    ReturnType<import('@playwright/test').BrowserContext['storageState']>
  >,
  url: string,
): Promise<number> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    locale: use.locale,
    timezoneId: use.timezoneId,
    colorScheme: use.colorScheme,
    // test.use() overrides are not in project.use, so the sample's motion is passed explicitly.
    reducedMotion: SAMPLE_MOTION,
    storageState,
  });
  try {
    const page = await context.newPage();
    const sample = await measure(page, url);
    (elements[url] ??= []).push(sample.element);
    return sample.ms;
  } finally {
    await context.close();
  }
}

async function measure(
  page: import('@playwright/test').Page,
  url: string,
): Promise<Sample> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  return page.evaluate(
    () =>
      new Promise<Sample>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries() as (PerformanceEntry & {
            element?: Element | null;
            url?: string;
          })[];
          const last = entries[entries.length - 1];
          const el = last?.element;
          resolve({
            ms: last?.startTime ?? -1,
            element: el
              ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}${last?.url ? ` ${last.url.slice(0, 80)}` : ''}`
              : 'none',
          });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
}

// The suite defaults to reduced motion; the sample must run the cover's animation (owner's
// exception, EXPERIENCE-AND-MOTION 7.11): the profile's LCP stays under 2000ms with it.
test.use({ reducedMotion: SAMPLE_MOTION });

test('lab LCP sample', async ({ page, browser }) => {
  // Fifteen throttled page loads, each in a fresh context, each followed by a pause for late paints.
  test.setTimeout(180_000);
  const post = async (path: string, body: unknown, headers = {}) =>
    (
      await (
        await fetch(`${API_ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
      ).json()
    ).data;
  const quote = await post('/v1/tip-quotes', {
    handle: 'tobi',
    amountMinor: '200000',
    currency: 'NGN',
  });
  const tip = await post(
    '/v1/tip-intents',
    { quoteId: quote.quoteId },
    { 'idempotency-key': randomUUID() },
  );
  // Tobi signs in through the API in this browser context (its cookies are shared with the page).
  const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };
  await page.request.post(`${API_ORIGIN}/v1/auth/code`, {
    headers,
    data: { phone: '+2348000000002' },
  });
  const inbox = await (
    await page.request.get(`${API_ORIGIN}/v1/dev/inbox`)
  ).json();
  const code = /\b(\d{6})\b/.exec(
    inbox.data.find((m: { to: string }) => m.to.endsWith('0002')).body,
  )?.[1];
  await page.request.post(`${API_ORIGIN}/v1/auth/verify`, {
    headers,
    data: { phone: '+2348000000002', code },
  });
  // Tobi is on Pro with Night sky on a slow loop, the heaviest animated cover, so /@tobi is sampled
  // with it playing. The plan is set in the test database only.
  const pro = await import('../../packages/database/dist/index.js');
  const proDb = pro.createDatabase(E2E_DATABASE_URL, { max: 1 });
  await proDb.pool
    .query("UPDATE profiles SET plan = 'pro' WHERE handle_lower = 'tobi'")
    .finally(() => proDb.close());
  const chosen = await page.request.put(`${API_ORIGIN}/v1/me/cover-design`, {
    headers,
    data: { design: null, animation: 'night', motion: 'loop' },
  });
  expect(chosen.status()).toBe(200);
  // Tobi is also made Owner (test database only) and opens an admin grant, to sample /ops.
  const ops = await import('../../packages/database/dist/index.js');
  const db = ops.createDatabase(E2E_DATABASE_URL, { max: 1 });
  const { enrolmentCode } = await ops
    .grantOwner(db.db, { phone: '+2348000000002' })
    .finally(() => db.close());
  const enrolment = await (
    await page.request.post(`${API_ORIGIN}/v1/ops/enrol`, {
      headers,
      data: { enrolmentCode },
    })
  ).json();
  const { totpAt } = await import('../../packages/domain/dist/index.js');
  await page.request.post(`${API_ORIGIN}/v1/ops/enrol/confirm`, {
    headers,
    data: {
      code: totpAt(
        enrolment.data.secret,
        BigInt(Math.floor(Date.now() / 30_000)) + BigInt(1),
      ),
    },
  });
  // The page is already showing the loop before anything is sampled. This warms only the
  // server; every sample below runs in a fresh browser context with an empty cache.
  await expect(async () => {
    await page.goto('/@tobi');
    expect(
      await page.locator('.profile-cover').getAttribute('data-cover-play'),
    ).toBe('loop');
  }).toPass({ timeout: 15_000 });
  const state = await page.context().storageState();
  const home: number[] = [];
  const profile: number[] = [];
  const status: number[] = [];
  const dashboard: number[] = [];
  const admin: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    home.push(await lcp(browser, state, '/'));
    profile.push(await lcp(browser, state, '/@tobi'));
    status.push(
      await lcp(browser, state, `/tip/${tip.tipId}#t=${tip.statusToken}`),
    );
    dashboard.push(await lcp(browser, state, '/dashboard'));
    admin.push(await lcp(browser, state, '/ops'));
  }
  for (const ms of profile) expect(ms, `/@tobi LCP ${ms}ms`).toBeLessThan(2000);
  const results = {
    '/': home,
    '/@tobi': profile,
    '/tip/<id>': status,
    '/dashboard': dashboard,
    '/ops': admin,
  };
  console.log(`LCP_ELEMENTS ${JSON.stringify(elements)}`);
  console.log(`LCP_RESULTS ${JSON.stringify(results)}`);
});
