import { expect, test } from '@playwright/test';
import { fitsViewport, signUpRecipient } from './helpers';

// Withdraw-and-audit PR S1 (ScreenSettings, ScreenAudit "Settings"). Settings stays one scrolling
// page with section links; these check where things land and sit, not new behaviour.

test('a link to a section lands on it once Settings has loaded', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  // The sections above load their own data and grow after the jump (the audit's "opens on My
  // page"): held here so that growth comes after the first scroll, as on a slow phone.
  const held = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise((done) => setTimeout(done, 1200));
    await route.fallback();
  };
  await page.route('**/v1/me/notification-preferences', held);
  await page.route('**/v1/me/sessions', held);
  for (const id of ['notifications', 'security', 'data']) {
    await page.goto('about:blank');
    const settled = page.waitForResponse(/\/v1\/me\/sessions/);
    await page.goto(`/dashboard/settings#${id}`);
    const section = page.locator(`section#${id}`);
    await expect(section.getByRole('heading', { level: 2 })).toBeVisible();
    await settled;
    // Whatever grew above it, the section is still at the top of the screen.
    await expect
      .poll(async () => (await section.boundingBox())!.y, {
        message: `#${id} is at the top of the screen`,
      })
      .toBeLessThan(160);
  }
});

test('settings on a desktop: the section list touches the content, and the preview stays beside My page', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/dashboard/settings');
  const nav = page.locator('nav[aria-label="Settings"]');
  const editor = page.locator('.settings-editor');
  const preview = page.locator('section#page .settings-preview');
  await expect(preview).toBeVisible();
  const navBox = (await nav.boundingBox())!;
  const chapter = (await page.locator('section#page').boundingBox())!;
  expect(chapter.x - (navBox.x + navBox.width)).toBeLessThanOrEqual(40);
  const editorBox = (await editor.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.x).toBeGreaterThanOrEqual(editorBox.x + editorBox.width);
  // Sticky: scrolling down the editor keeps the preview in view.
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => {
      const box = (await preview.boundingBox())!;
      return box.y >= 0 && box.y < 800;
    })
    .toBe(true);
  expect(await fitsViewport(page)).toBe(true);
});

test('the cover grid shows three across in the editor column', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/settings');
  const choices = page.locator('#cover .cover-choices__grid').first();
  await expect(choices).toBeVisible();
  const tops = await choices
    .locator(':scope > .cover-choice')
    .evaluateAll((items) =>
      items.map((item) => Math.round(item.getBoundingClientRect().top)),
    );
  expect(tops.length).toBeGreaterThan(3);
  expect(tops.filter((top) => top === tops[0])).toHaveLength(3);
  const heights = await choices
    .locator(':scope > .cover-choice')
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().height),
    );
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
});
