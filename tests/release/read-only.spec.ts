import { expect, test } from '@playwright/test';
import { expectAccessible } from '../e2e/helpers';
import { apiCall, env, newVisitor, throttledLcp } from './client';

// Read-only: safe on any copy, including one with real people. It creates nothing.

test('the copy reports itself honestly: live payments as expected, the expected version', async ({
  request,
}) => {
  const response = await request.get(`${env.api}/health/release`, {
    ignoreHTTPSErrors: env.insecure,
  });
  expect(response.status()).toBe(200);
  const info = (await response.json()).data;
  expect(info.paymentsLive).toBe(env.expectLive);
  if (env.expectVersion) expect(info.version).toBe(env.expectVersion);
  const ready = await request.get(`${env.api}/health/ready`, {
    ignoreHTTPSErrors: env.insecure,
  });
  expect(ready.status()).toBe(200);
});

test('the API accepts browser calls from the public web address it is checked with', async ({
  request,
}) => {
  const info = (
    await (
      await request.get(`${env.api}/health/release`, {
        ignoreHTTPSErrors: env.insecure,
      })
    ).json()
  ).data;
  // A preview copy answers nothing without its password, preflights included.
  test.skip(info.deploymentMode === 'preview', 'preview copy: gated');
  const origin = new URL(env.web).origin;
  // WEB_ORIGIN set to another host (for example the apex instead of www) blocks every
  // credentialed browser call with a CORS error, while the API itself looks healthy.
  const preflight = await request.fetch(`${env.api}/v1/me/profile`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET' },
    ignoreHTTPSErrors: env.insecure,
  });
  const headers = preflight.headers();
  expect(
    headers['access-control-allow-origin'],
    `API WEB_ORIGIN does not match ${origin}`,
  ).toBe(origin);
  expect(headers['access-control-allow-credentials']).toBe('true');
});

test('a preview copy refuses the API without its password, including the pretend inbox', async ({
  request,
}) => {
  const info = (
    await (
      await request.get(`${env.api}/health/release`, {
        ignoreHTTPSErrors: env.insecure,
      })
    ).json()
  ).data;
  test.skip(info.deploymentMode !== 'preview', 'not a preview copy');
  const inbox = await request.get(`${env.api}/v1/dev/inbox`, {
    ignoreHTTPSErrors: env.insecure,
  });
  expect(inbox.status()).toBe(401);
});

test('public pages load fast on a throttled phone and pass accessibility checks', async ({
  browser,
}) => {
  const context = await newVisitor(browser);
  const page = await context.newPage();
  const paths = ['/', '/sign-in', ...(env.handle ? [`/@${env.handle}`] : [])];
  for (const path of paths) {
    const lcp = await throttledLcp(page, path);
    expect(lcp, `LCP ${path}`).toBeGreaterThan(0);
    expect(lcp, `LCP ${path}`).toBeLessThanOrEqual(2000);
    await expectAccessible(page);
  }
  await context.close();
});

test('private areas stay out of search and refuse outsiders', async ({
  browser,
}) => {
  const context = await newVisitor(browser);
  const page = await context.newPage();
  for (const path of ['/dashboard', '/ops']) {
    // The server's HTML, before any client-side redirect.
    const html = await (await page.request.get(path)).text();
    expect(html, path).toMatch(/<meta name="robots" content="[^"]*noindex/);
  }
  const me = await apiCall(page.request, 'GET', '/v1/ops/me');
  expect(me.status()).toBe(404);
  await context.close();
});
