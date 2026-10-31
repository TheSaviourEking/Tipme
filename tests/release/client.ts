import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
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
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await page.getByLabel('6-digit code').fill(await readCode(page, email, seen));
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Largest Contentful Paint on a throttled mid-range phone (lab measure, like `pnpm perf:lab`). */
export async function throttledLcp(page: Page, url: string): Promise<number> {
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
  return value;
}
