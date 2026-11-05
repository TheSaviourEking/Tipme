import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startTip } from '../shared/tip-flow';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { API_ORIGIN, E2E_REVALIDATE_SECRET } from './stack';

// playwright.config.ts starts the web server with PILOT_NOTICE=on. This stack runs the pretend
// provider (payment mode "test"), where "Payments are real" would be false, so the notice must be
// absent. The second test starts a second web server whose release lookup says "live" and shows
// where the notice goes in live mode; the unit tests (apps/web/test/pilot.test.mjs) cover the
// "closed" mode and the setting being off.
const SENTENCE =
  'TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz';
const notice = (page: Page) => page.getByTestId('pilot-notice');

async function expectNoNotice(page: Page) {
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByText(/in a pilot/)).toHaveCount(0);
  await expect(
    page.locator('a[href="mailto:support@usetipme.xyz"]'),
  ).toHaveCount(0);
}

test('PILOT_NOTICE=on shows nothing on a test-mode copy', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.getByRole('radio', { name: '2,000 NGN' })).toBeVisible(
      { timeout: 1000 },
    );
  }).toPass({ timeout: 10_000 });
  // The page itself says it is a test, so the notice would contradict it.
  await expect(
    visitor
      .locator('.composer-disclaimer')
      .getByText('TipMe is in test mode: no real money moves yet.'),
  ).toBeVisible();
  await expectNoNotice(visitor);
  await startTip(visitor, {});
  await visitor.waitForURL(/\/mock-checkout\//);
  await expectNoNotice(visitor);
  await visitor.getByRole('button', { name: /^Pay/ }).click();
  await visitor.waitForURL(/\/tip\//);
  await expect(visitor.getByText('Test payment')).toBeVisible();
  await expectNoNotice(visitor);
  await visitor.context().close();

  for (const path of ['/dashboard', '/dashboard/withdraw']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectNoNotice(page);
  }
});

/** The API as the web sees it, except that its release lookup says live payments are on. */
function liveReleaseStub(): Promise<{ origin: string; close: () => void }> {
  const api = new URL(API_ORIGIN);
  const server = http.createServer((req, res) => {
    if (req.url?.split('?')[0] === '/health/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: { paymentProvider: 'bachs-live', paymentsLive: true },
        }),
      );
      return;
    }
    const upstream = http.request(
      {
        host: api.hostname,
        port: api.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    }),
  );
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Lets a page on the second web server call the API the first one is configured for. */
async function allowApiCalls(context: BrowserContext, webOrigin: string) {
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': webOrigin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers':
        request.headers()['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    };
    if (request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: cors });
    // The live stream never ends, so re-fetching it outlives the page ("Request context
    // disposed"). 204 is the API's "live updates off": the page carries on without them.
    if (new URL(request.url()).pathname === '/v1/me/events')
      return route.fulfill({ status: 204, headers: cors });
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), ...cors },
    });
  });
}

test.describe('live mode', () => {
  let web: ChildProcess | undefined;
  let stub: { origin: string; close: () => void } | undefined;
  let origin = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    stub = await liveReleaseStub();
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    web = spawn(
      'pnpm',
      ['--filter', '@tipme/web', 'start', '--port', String(port)],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '',
          API_INTERNAL_ORIGIN: stub.origin,
          WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
          PILOT_NOTICE: 'on',
        },
      },
    );
    await expect(async () => {
      const response = await fetch(`${origin}/for-creators`);
      expect(response.ok).toBe(true);
    }).toPass({ timeout: 90_000 });
  });

  // Only the processes started here are stopped.
  test.afterAll(() => {
    if (web?.pid) process.kill(-web.pid);
    stub?.close();
  });

  test('the notice sits with the Tip button, the receipt, the dashboard and Withdraw @mobile', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const { handle } = await signUpRecipient(page, testInfo);

    // A receipt, made through the pretend provider on the normal stack.
    const supporter = await (await browser.newContext()).newPage();
    await expect(async () => {
      await supporter.goto(`/@${handle}`);
      await expect(
        supporter.getByRole('radio', { name: '2,000 NGN' }),
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await startTip(supporter, {});
    await supporter.waitForURL(/\/mock-checkout\//);
    await supporter.getByRole('button', { name: /^Pay/ }).click();
    await supporter.waitForURL(/\/tip\//);
    await expect(supporter.getByText('Test payment')).toBeVisible();
    // The page keeps the private token in its tab's session; carry it in the link, as Copy does.
    const tipId = new URL(supporter.url()).pathname.split('/').pop();
    const token = await supporter.evaluate(
      (id) => sessionStorage.getItem(`tipme.token.${id}`) ?? '',
      tipId,
    );
    expect(token).not.toBe('');
    const receipt = `/tip/${tipId}#t=${token}`;
    await supporter.context().close();

    // The same people, seen through a copy whose payments are live.
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 360, height: 800 },
    });
    await context.addCookies(await page.context().cookies());
    await allowApiCalls(context, origin);
    const live = await context.newPage();

    await live.goto(`/@${handle}`);
    const panel = live.locator('[data-tip-panel]');
    const tip = panel.getByRole('button', { name: /^Tip/ });
    await expect(tip).toBeVisible();
    // Under the Tip button, in the same panel, not in the footer.
    await expect(panel.getByTestId('pilot-notice')).toHaveText(SENTENCE);
    await expect(live.locator('footer [data-testid=pilot-notice]')).toHaveCount(
      0,
    );
    await expect(
      panel.getByRole('link', { name: 'support@usetipme.xyz' }),
    ).toHaveAttribute('href', 'mailto:support@usetipme.xyz');
    // On a phone the Tip button is in the fixed bar, and the same words sit directly above it
    // there; elsewhere the notice is the line under the button.
    const bar = live.locator('.composer-action__notice');
    const tipBox = (await tip.boundingBox())!;
    if (await bar.isVisible()) {
      await expect(bar).toHaveText(SENTENCE);
      const barBox = (await bar.boundingBox())!;
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(tipBox.y);
      expect(tipBox.y - (barBox.y + barBox.height)).toBeLessThan(40);
    } else {
      const noticeBox = (await notice(live).boundingBox())!;
      expect(noticeBox.y).toBeGreaterThan(tipBox.y);
      expect(noticeBox.y - (tipBox.y + tipBox.height)).toBeLessThan(80);
    }
    expect(await notice(live).innerText()).not.toMatch(/bachs/i);
    await expect(live.locator('meta[name="robots"]').first()).toHaveAttribute(
      'content',
      /noindex/,
    );
    await expectAccessible(live);

    await live.setViewportSize({ width: 320, height: 720 });
    expect(await fitsViewport(live)).toBe(true);

    await live.goto(receipt);
    await expect(live.locator('.tip-thanks')).toContainText(
      /got your thanks\./,
      {
        timeout: 20_000,
      },
    );
    await expect(
      live.locator('.tip-thanks').getByTestId('pilot-notice'),
    ).toHaveText(SENTENCE);
    expect(await fitsViewport(live)).toBe(true);
    await expectAccessible(live);

    await live.goto('/dashboard');
    await expect(
      live.getByRole('navigation', { name: 'Dashboard' }),
    ).toBeVisible();
    await expect(live.getByTestId('pilot-notice')).toHaveCount(1);
    await expect(live.getByTestId('pilot-notice')).toHaveText(SENTENCE);
    expect(await fitsViewport(live)).toBe(true);
    await expectAccessible(live);

    await live.goto('/dashboard/withdraw');
    // Exact: "Your withdrawals" is a heading on this page too.
    await expect(
      live.getByRole('heading', { name: 'Withdraw', exact: true }),
    ).toBeVisible();
    await expect(live.getByTestId('pilot-notice')).toHaveCount(1);
    expect(await fitsViewport(live)).toBe(true);
    await expectAccessible(live);
    await context.close();
  });
});
