import { expect, test } from '@playwright/test';

// Each new style's lab example at a phone and a wide desktop, light (spec 2026-11-17-page-studio-
// styles §14.4). Linux CI is the authority for these images: the Linux baselines come only from a
// CI run's artifacts. The Darwin copies are for local runs (as profile.visual).
const SHOTS = [
  ['clear', 390],
  ['clear', 1440],
  ['journal', 390],
  ['journal', 1440],
  ['linen', 390],
  ['linen', 1440],
  ['stage', 390],
  ['stage', 1440],
  ['horizon', 390],
  ['horizon', 1440],
] as const;

for (const [style, width] of SHOTS)
  test(`${style[0]!.toUpperCase()}${style.slice(1)} at ${width} light`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dev/studio-lab?style=${style}&mode=light`);
    await page.locator('.studio[data-style]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    // The tip form has started and its observer has placed the phone's bar (data-bar).
    await page
      .locator('form[data-skin][data-bar]')
      .waitFor({ state: 'attached' });
    // Photos are generated SVGs; wait for every one in view so the capture is stable.
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.loading === 'lazy' || i.complete),
    );
    await expect(page).toHaveScreenshot(`studio-${style}-${width}-light.png`, {
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
    });
  });

// Classic's choices (PR 2b, §9.1): today's page in dark, with an accent and blocks.
test('Classic at 390 dark with an accent and blocks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=classic&mode=dark&accent=green');
  await page.locator('[data-style="classic"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.loading === 'lazy' || i.complete),
  );
  await expect(page).toHaveScreenshot('studio-classic-390-dark-green.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

// Stage is dark-first (§9.4, §14.4): its phone in dark too, the glow behind the cover.
test('Stage at 390 dark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=stage&mode=dark');
  await page.locator('.studio[data-style]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page
    .locator('form[data-skin][data-bar]')
    .waitFor({ state: 'attached' });
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.loading === 'lazy' || i.complete),
  );
  await expect(page).toHaveScreenshot('studio-stage-390-dark.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});
