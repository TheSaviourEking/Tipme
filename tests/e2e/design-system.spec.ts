import { expect, test } from '@playwright/test';

test('the lever is one tab stop, and arrow keys move and select', async ({
  page,
}) => {
  await page.goto('/design-system');
  const lever = page.getByRole('radiogroup', { name: 'Plan' });
  // One tab stop: only the checked option is in the tab order.
  await expect(lever.getByRole('radio', { name: 'Pro' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await lever.getByRole('radio', { name: 'Free' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(lever.getByRole('radio', { name: 'Pro' })).toBeChecked();
  await expect(lever.getByRole('radio', { name: 'Pro' })).toBeFocused();
});

test('pressing a raised action moves it down without its shadow', async ({
  page,
}) => {
  await page.goto('/design-system');
  const button = page.getByRole('button', { name: 'Continue' });
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pressed = await button.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.up();
  expect(pressed).toMatch(/matrix\(1, 0, 0, 1, 0, (1|2)\)/);
});

test('in forced colours every key, well and lever keeps an edge, and the selected key its dot', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/design-system');
  for (const selector of ['.tm-choice span', '.tm-well', '.tm-lever'])
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
    ).not.toBe('none');
  const dot = await page
    .locator('.tm-choice input:checked + span')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').content);
  expect(dot).not.toBe('none');
});

test('with reduced motion the lever does not slide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/design-system');
  const thumb = page.locator('.tm-lever__thumb');
  expect(
    await thumb.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
});
