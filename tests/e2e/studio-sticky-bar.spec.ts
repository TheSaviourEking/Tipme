import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';

// The sticky Tip bar on a styled page (spec 2026-11-17-page-studio-styles §8, §14.9): one small
// IntersectionObserver in the tip form watches the in-page Tip button. The bar shows once that
// button scrolls away and hides while it is on screen; without JavaScript it is always shown
// (Classic's behaviour). The page keeps room under its last block for it; desktops have none.
const LAB = '/dev/studio-lab?style=clear';
const PHONE = { width: 390, height: 844 };

const form = (page: Page) => page.locator('form[data-skin]');
const bar = (page: Page) => page.locator('form[data-skin] .tip-bar');
// The bar's button is a real button too (named the same); the in-page one sits in the form's action.
const inPageTip = (page: Page) =>
  form(page).locator('.composer-action').getByRole('button', { name: /^Tip/ });

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

test('with JavaScript disabled the page still keeps room for the whole bar @mobile', async ({
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
    // No script measures the bar, so the page's bottom padding falls back to a fixed reserve: it
    // must hold the bar as drawn (notice included), or the bar covers the page's end.
    const { reserve, barHeight } = await page.evaluate(() => ({
      reserve: parseFloat(
        getComputedStyle(document.querySelector('.studio-page')!).paddingBottom,
      ),
      barHeight: document.querySelector('.tip-bar')!.getBoundingClientRect()
        .height,
    }));
    expect(reserve).toBeGreaterThanOrEqual(barHeight);
  } finally {
    await context.close();
  }
});

test('a link focused from the keyboard is never hidden under the bar @mobile', async ({
  page,
}) => {
  await open(page);
  const links = page.locator('.studio-foot a');
  const last = links.last();
  // Scroll until the last footer link sits at the very bottom of the screen, behind the bar.
  await page.evaluate(() =>
    scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await expect(bar(page)).toBeVisible();
  await last.evaluate((a) => {
    const box = a.getBoundingClientRect();
    scrollBy({ top: box.bottom - (innerHeight - 4), behavior: 'instant' });
  });
  await expect(form(page)).toHaveAttribute('data-bar', 'shown');
  // Tab onto it from the link before: the page's scroll padding must bring it above the bar
  // (WCAG 2.4.11), as the form's own scroll-into-view of a problem relies on.
  await links
    .nth((await links.count()) - 2)
    .evaluate((a) => (a as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  const barTop = (await bar(page).boundingBox())!.y;
  const box = (await last.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(barTop);
});

test("the bar's Tip is a real button, and a failed quote shows in the bar with Try again @mobile", async ({
  page,
}) => {
  await open(page);
  // The lab's page has no account behind it, so the real API refuses the quote.
  await inPageTip(page).click();
  const failure = form(page).locator('.composer-action .tm-field-error');
  await expect(failure).toBeVisible();
  const message = (await failure.textContent())!;
  await page.evaluate(() =>
    scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await expect(form(page)).toHaveAttribute('data-bar', 'shown');
  await expect(bar(page)).toContainText(message);
  const retry = bar(page).getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  // In the accessibility tree and the tab order while shown.
  expect(await retry.getAttribute('aria-hidden')).toBeNull();
  expect(await retry.getAttribute('tabindex')).toBeNull();
  await expectAccessible(page);
});
