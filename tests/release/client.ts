import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Cookie,
  type Page,
} from '@playwright/test';

// Shared helpers for the release check (PR-010). Settings come from scripts/release-check.mjs.
export const env = {
  web: process.env.RELEASE_WEB ?? '',
  api: process.env.RELEASE_API ?? '',
  previewPassword: process.env.RELEASE_PREVIEW_PASSWORD ?? '',
  token: process.env.RELEASE_CHECK_TOKEN ?? '',
  opsEmail: process.env.RELEASE_OPS_EMAIL ?? '',
  opsTotpSecret: process.env.RELEASE_OPS_TOTP_SECRET ?? '',
  handle: process.env.RELEASE_HANDLE ?? '',
  expectVersion: process.env.RELEASE_EXPECT_VERSION ?? '',
  /** Whether this copy should take real money (--expect-live); false unless it was told so. */
  expectLive: process.env.RELEASE_EXPECT_LIVE === 'true',
  /** `report`: the LCP budget is measured and printed but never fails (production deploys). */
  speedReportOnly: process.env.RELEASE_SPEED === 'report',
  insecure: process.env.RELEASE_INSECURE === '1',
  paymentProvider: process.env.RELEASE_PAYMENT_PROVIDER ?? 'mock',
  /** On the Bachs sandbox: a standing page whose Bachs account was set up by hand. */
  bachsHandle: process.env.RELEASE_BACHS_HANDLE ?? '',
};

/** A new browser context that has passed the staging password (when the copy has one). */
export async function newVisitor(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: env.insecure });
  if (env.previewPassword) {
    const page = await context.newPage();
    await page.goto('/preview-login?next=/');
    await page.getByLabel('Staging password').fill(env.previewPassword);
    await page.getByRole('button', { name: 'Open staging' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/preview-login'));
    await page.close();
  }
  return context;
}

// The staging password's ticket (apps/web/src/lib/preview-gate.ts, PREVIEW_COOKIE).
const PREVIEW_COOKIE = '__Secure-tipme_preview';
let previewTicket: Cookie[] | undefined;

/**
 * A first-time visitor for a speed measurement: a new context with an empty cache. On a copy with
 * a staging password it carries only the password's ticket, taken once from a separate context.
 * newVisitor would load /preview-login in the same context first, and that page's stylesheet and
 * fonts are the home page's, so a staging copy measured a warm cache (about 350 ms) while
 * production, with no password, measured a true first visit (15 Nov 2026).
 */
export async function coldVisitor(browser: Browser): Promise<BrowserContext> {
  if (env.previewPassword && !previewTicket) {
    const gate = await newVisitor(browser);
    previewTicket = (await gate.cookies()).filter(
      (cookie) => cookie.name === PREVIEW_COOKIE,
    );
    await gate.close();
    expect(previewTicket, 'the staging password gave no ticket').toHaveLength(
      1,
    );
  }
  const context = await browser.newContext({ ignoreHTTPSErrors: env.insecure });
  if (previewTicket) await context.addCookies(previewTicket);
  return context;
}

/** Calls the API as this browser context would (its cookies), as the web app's origin. */
export function apiCall(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return request.fetch(`${env.api}${path}`, {
    method,
    headers: {
      origin: env.web,
      'x-tipme-csrf': '1',
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(data === undefined ? {} : { data }),
    ignoreHTTPSErrors: env.insecure,
  });
}

type Message = { id: string; to: string; subject: string | null; body: string };

/** How the pretend inbox shows an address: its first letter and its domain. */
const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

const codeMessages = async (page: Page, email: string): Promise<Message[]> => {
  const inbox =
    await // On a preview copy the inbox also needs the release token.
    (
      await apiCall(
        page.request,
        'GET',
        '/v1/dev/inbox',
        undefined,
        env.token ? { authorization: `Bearer ${env.token}` } : {},
      )
    ).json();
  return (inbox.data as Message[]).filter(
    (m) =>
      m.to === hintOf(email) && /Your TipMe sign-in code/.test(m.subject ?? ''),
  );
};

/** The code from a message newer than `seen` (staging delivers nothing for real). */
export async function readCode(
  page: Page,
  email: string,
  seen: Set<string>,
): Promise<string> {
  let code = '';
  await expect(async () => {
    const fresh = (await codeMessages(page, email)).find(
      (m) => !seen.has(m.id),
    );
    code = /\b(\d{6})\b/.exec(fresh?.body ?? '')?.[1] ?? '';
    expect(code).not.toBe('');
    // The worker sends queued mail every few seconds.
  }).toPass({ timeout: 30_000 });
  return code;
}

export async function signIn(page: Page, email: string, start = '/sign-in') {
  await page.goto(start);
  // Codes from earlier runs to the same address are not this sign-in's code.
  const seen = new Set((await codeMessages(page, email)).map((m) => m.id));
  // With the business_signup switch on, /sign-up first asks "What brings you to TipMe?". The
  // release check takes the personal path, "Get tipped", as the e2e helpers do.
  const emailField = page.getByLabel('Email address');
  const fork = page.getByRole('radiogroup', {
    name: 'What brings you to TipMe?',
  });
  await expect(emailField.or(fork)).toBeVisible();
  if (await fork.isVisible()) {
    await fork.getByRole('radio', { name: /^Get tipped/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await emailField.fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await page.getByLabel('6-digit code').fill(await readCode(page, email, seen));
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * Largest Contentful Paint on a throttled mid-range phone (lab measure, like `pnpm perf:lab`), and
 * the requests the browser answered from its cache instead of the network: none on a first visit.
 */
export async function throttledLcp(
  page: Page,
  url: string,
): Promise<{ ms: number; fromCache: string[] }> {
  const cdp = await page.context().newCDPSession(page);
  const fromCache: string[] = [];
  const urls = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (event) =>
    urls.set(event.requestId, event.request.url),
  );
  cdp.on('Network.requestServedFromCache', (event) =>
    fromCache.push(urls.get(event.requestId) ?? event.requestId),
  );
  cdp.on('Network.responseReceived', (event) => {
    if (event.response.fromDiskCache || event.response.fromPrefetchCache)
      fromCache.push(event.response.url);
  });
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
  const value = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve(entries[entries.length - 1]?.startTime ?? -1);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  return { ms: value, fromCache: [...new Set(fromCache)] };
}
