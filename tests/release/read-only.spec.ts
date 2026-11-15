import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectAccessible } from '../e2e/helpers';
import { apiCall, coldVisitor, env, newVisitor, throttledLcp } from './client';

const LCP_BUDGET_MS = 2000;

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
    // One load can land on either of two speeds about 700 ms apart with the same response time,
    // so a single number passes or fails by chance. Three fresh visitors, and the middle one counts.
    // Each is a first visit (coldVisitor): on a staging copy too, nothing comes from the cache.
    const loads: number[] = [];
    for (let visit = 0; visit < 3; visit += 1) {
      const visitor = await coldVisitor(browser);
      const { ms, fromCache } = await throttledLcp(
        await visitor.newPage(),
        path,
      );
      await visitor.close();
      expect(fromCache, `LCP ${path} measured a warm cache`).toEqual([]);
      loads.push(ms);
    }
    const lcp = [...loads].sort((a, b) => a - b)[1]!;
    const line = `LCP ${path}: ${loads.map(Math.round).join(', ')} ms, median ${Math.round(lcp)} ms`;
    console.log(line);
    await page.goto(path, { waitUntil: 'load' });
    expect(lcp, `LCP ${path}`).toBeGreaterThan(0);
    if (env.speedReportOnly) {
      // Production: report, never fail (see --speed in scripts/release-check.mjs).
      const over = lcp > LCP_BUDGET_MS;
      test.info().annotations.push({
        type: over ? 'warning' : 'lcp',
        description: `${line} (budget ${LCP_BUDGET_MS} ms, report only)`,
      });
      if (over)
        console.warn(
          `::warning::${line} is over ${LCP_BUDGET_MS} ms (report only)`,
        );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `- ${over ? 'Over budget (report only)' : 'Within budget'}: ${line}\n`,
        );
    } else {
      expect(lcp, `LCP ${path}`).toBeLessThanOrEqual(LCP_BUDGET_MS);
    }
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
