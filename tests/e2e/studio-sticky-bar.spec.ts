import { expect, test, type Page } from '@playwright/test';

// The sticky Tip bar on a styled page (spec 2026-11-17-page-studio-styles §8, §14.9): one small
// IntersectionObserver in the tip form watches the in-page Tip button. The bar shows once that
// button scrolls away and hides while it is on screen; without JavaScript it is always shown
// (Classic's behaviour). The page keeps room under its last block for it; desktops have none.
const LAB = '/dev/studio-lab?style=clear';
const PHONE = { width: 390, height: 844 };

const form = (page: Page) => page.locator('form[data-skin]');
const bar = (page: Page) => page.locator('form[data-skin] .tip-bar');
const inPageTip = (page: Page) =>
  form(page).getByRole('button', { name: /^Tip/ });

async function open(page: Page) {
  await page.setViewportSize(PHONE);
  await page.goto(LAB);
  await page.locator('.studio[data-style]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

test('the bar is hidden while the in-page Tip is on screen and shown after it scrolls away @mobile', async ({
  page,
}) => {
  await open(page);
  await expect(inPageTip(page)).toBeInViewport();
  await expect(form(page)).toHaveAttribute('data-bar', 'hidden');
  await expect(bar(page)).toBeHidden();
  // Away from the in-page Tip: the bar comes up, at the bottom of the screen, with the amount.
  await page.evaluate(() =>
    scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await expect(inPageTip(page)).not.toBeInViewport();
  await expect(form(page)).toHaveAttribute('data-bar', 'shown');
  await expect(bar(page)).toBeVisible();
  const box = await bar(page).boundingBox();
  expect(Math.round(box!.y + box!.height)).toBe(PHONE.height);
  await expect(bar(page).locator('button')).toHaveText(
    (await inPageTip(page).textContent())!,
  );
  // Back up: the in-page Tip is on screen again and the bar goes.
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(form(page)).toHaveAttribute('data-bar', 'hidden');
  await expect(bar(page)).toBeHidden();
});

test('with JavaScript disabled the bar is always shown @mobile', async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: PHONE,
  });
  try {
    const page = await context.newPage();
    await page.goto(LAB);
    await page.locator('.studio[data-style]').waitFor();
    await expect(form(page)).toHaveAttribute('data-bar', 'shown');
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() =>
      scrollTo({ top: document.documentElement.scrollHeight }),
    );
    await expect(bar(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the bar never covers the last block @mobile', async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await expect(bar(page)).toBeVisible();
  const barTop = (await bar(page).boundingBox())!.y;
  // The last block and the footer's last link both end above the bar.
  for (const last of [
    page.locator('.studio-block').last(),
    page.locator('.studio-foot a').last(),
  ]) {
    const box = (await last.boundingBox())!;
    expect(
      box.y + box.height,
      await last.evaluate((e) => e.className),
    ).toBeLessThanOrEqual(barTop);
  }
});

test('no sticky bar at 1024 and wider', async ({ page }) => {
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(LAB);
    await page.locator('.studio[data-style]').waitFor();
    await page.evaluate(() =>
      scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'instant',
      }),
    );
    await expect(inPageTip(page)).not.toBeInViewport();
    await expect(bar(page), `${width}px`).toBeHidden();
  }
});
