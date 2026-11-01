import { expect, test, type Page } from '@playwright/test';
import { startTip } from '../shared/tip-flow';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';

// The web server reads PILOT_NOTICE per request. playwright.config.ts passes E2E_PILOT_NOTICE
// through to it, so one run checks "off" (the default) and another, with E2E_PILOT_NOTICE=on,
// checks "on".
const on = process.env.E2E_PILOT_NOTICE === 'on';
const SENTENCE =
  'TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz';

async function expectNotice(page: Page) {
  const notice = page.getByTestId('pilot-notice');
  if (!on) {
    await expect(notice).toHaveCount(0);
    await expect(page.getByText(/in a pilot/)).toHaveCount(0);
    await expect(
      page.locator('a[href="mailto:support@usetipme.xyz"]'),
    ).toHaveCount(0);
    return;
  }
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText(SENTENCE);
  await expect(
    notice.getByRole('link', { name: 'support@usetipme.xyz' }),
  ).toHaveAttribute('href', 'mailto:support@usetipme.xyz');
  // Quiet: it rests in the footer after the page content, never above it.
  await expect(
    page.locator('footer.site-footer [data-testid=pilot-notice]'),
  ).toHaveCount(1);
  const [main, box] = await Promise.all([
    page.locator('main').first().boundingBox(),
    notice.boundingBox(),
  ]);
  expect(box!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1);
  // The provider is never named.
  expect(await notice.innerText()).not.toMatch(/bachs/i);
}

test.describe(`pilot notice ${on ? 'on' : 'off'}`, () => {
  test('shows on the profile, checkout, receipt and dashboard only when switched on', async ({
    page,
    browser,
  }, testInfo) => {
    const { handle } = await signUpRecipient(page, testInfo);

    const visitor = await (await browser.newContext()).newPage();
    await expect(async () => {
      await visitor.goto(`/@${handle}`);
      await expect(
        visitor.getByRole('radio', { name: '2,000 NGN' }),
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expectNotice(visitor);
    // Reflow at 320px, the notice included, and the tip action keeps its place.
    await visitor.setViewportSize({ width: 320, height: 720 });
    expect(await fitsViewport(visitor)).toBe(true);
    const tip = visitor.getByRole('button', { name: /^Tip/ });
    await expect(tip).toBeVisible();
    await expectAccessible(visitor);

    await startTip(visitor, {});
    await visitor.waitForURL(/\/mock-checkout\//);
    await expectNotice(visitor);
    await visitor.getByRole('button', { name: /^Pay/ }).click();
    await visitor.waitForURL(/\/tip\//);
    await expectNotice(visitor);
    expect(await fitsViewport(visitor)).toBe(true);
    await expectAccessible(visitor);
    await visitor.context().close();

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectNotice(page);
    await expectAccessible(page);
  });
});
