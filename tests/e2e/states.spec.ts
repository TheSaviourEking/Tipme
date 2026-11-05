import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { LONG_NAME, UNBROKEN_NAME } from './profile-fixtures';

// The states primitives (docs/superpowers/plans/2026-11-05-states.md, PR A) on the design system's
// States specimen. Playwright runs with reduced motion by default; the motion tests say otherwise.

const specimen = (page: Page) => page.getByTestId('states-specimen');
const saveKey = (page: Page) =>
  specimen(page).getByRole('button', {
    name: /^(Save notifications|Saved\.)$/,
  });
/** CSS animations only: a field's colour transitions are not the shake. */
const shakes = (field: Locator) =>
  field.evaluate(
    (el) => el.getAnimations().filter((a) => a instanceof CSSAnimation).length,
  );

test('every state pattern is on the design system page and passes axe', async ({
  page,
}) => {
  await page.goto('/design-system');
  const states = specimen(page);
  await expect(states).toBeVisible();
  expect(await states.locator('.tm-slip').count()).toBeGreaterThanOrEqual(6);
  await expect(states.locator('.tm-warning')).toHaveCount(1);
  await expect(states.locator('[data-result]')).toHaveCount(0);
  await expect(saveKey(page)).toBeVisible();
  await expect(states.locator('.tm-empty-slip')).toHaveCount(1);
  await expect(states.locator('.tm-empty-well')).toHaveCount(1);
  await expect(states.locator('.tm-steps')).toHaveCount(2);
  // The Feedback section's held results.
  await expect(page.locator('.tm-key-result--failed')).toHaveCount(1);
  await expect(page.locator('[data-result="done"]')).toHaveCount(1);
  await expectAccessible(page);
});

test('no state shows a tinted box or a "!" or "✓" in front of words', async ({
  page,
}) => {
  await page.goto('/design-system');
  await expect(page.locator('.tm-notice, .tm-empty')).toHaveCount(0);
  expect(await specimen(page).innerText()).not.toMatch(/(^|\s)[!✓]\s/);
});

test('a slip only says money is safe where it is given that line', async ({
  page,
}) => {
  await page.goto('/design-system');
  const states = specimen(page);
  const notConfirmed = states
    .locator('.tm-slip')
    .filter({ hasText: 'Not confirmed' });
  await expect(notConfirmed).toHaveCount(1);
  await expect(notConfirmed.locator('.tm-slip__safe')).toHaveCount(0);
  await expect(
    states.locator('.tm-slip').filter({ hasText: 'Not sent yet' }),
  ).toHaveAttribute('role', 'alert');
});

test('a done key settles for about two seconds, then springs back', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/design-system');
  const key = saveKey(page);
  await key.click();
  // In flight: busy and still focusable, never disabled.
  await expect(key).toHaveAttribute('aria-busy', 'true');
  await expect(key).toHaveAttribute('aria-disabled', 'true');
  await expect(key).toBeEnabled();
  await page.clock.runFor(500);
  await expect(key).toHaveAttribute('data-result', 'done');
  await expect(key).toHaveText('Saved.');
  await expect(
    specimen(page).getByRole('status').filter({ hasText: 'Saved.' }),
  ).toBeAttached();
  await page.clock.runFor(2100);
  await expect(key).not.toHaveAttribute('data-result');
  await expect(key).toHaveText('Save notifications');
});

test('a failed key moves focus to Try again, and Try again sends again', async ({
  page,
}) => {
  await page.goto('/design-system');
  const states = specimen(page);
  await states.getByRole('button', { name: 'Make the next save fail' }).click();
  await saveKey(page).focus();
  await page.keyboard.press('Enter');
  await expect(saveKey(page)).toHaveAttribute('aria-busy', 'true');
  await expect(saveKey(page)).toBeFocused();
  const again = states.locator('.tm-key-result__again');
  await expect(again).toBeFocused();
  await expect(again).toHaveText('Try again');
  // Focus lands on Try again, so it says what failed.
  await expect(again).toHaveAccessibleDescription(/Not saved/);
  // The caller's test id stays on the key in its failed state.
  await expect(states.getByTestId('states-save-key')).toHaveAttribute(
    'data-result',
    'failed',
  );
  await expect(states.locator('.tm-key-result__face')).toContainText(
    'Not saved',
  );
  await expect(
    states.getByRole('alert').filter({ hasText: 'We couldn’t save that.' }),
  ).toBeAttached();
  const box = (await again.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  // Try again runs the latest save: the toggle was used up, so this one goes through.
  await page.keyboard.press('Enter');
  const key = saveKey(page);
  // While the retry is in flight focus stays on the key, not the page.
  await expect(key).toHaveAttribute('aria-busy', 'true');
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute('data-result', 'done');
  await expect(key).toBeFocused();
  await expect(again).toHaveCount(0);
});

test('typing into a flagged field as its error clears keeps the same input, its focus and its value', async ({
  page,
}) => {
  await page.goto('/design-system');
  const states = specimen(page);
  const field = states.getByLabel('Other amount (NGN 2,000 or more)');
  const before = await field.elementHandle();
  await states.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(states.locator('.tm-field-flag')).toHaveText('below 2,000');
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type('0');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(states.locator('.tm-field-flag')).toHaveCount(0);
  await page.keyboard.type('0');
  expect(
    await before!.evaluate(
      (el) => el.isConnected && el === document.activeElement,
    ),
  ).toBe(true);
  await expect(field).toHaveValue('1,50000');
});

for (const [form, wrapper] of [
  ['tip form', 'div.tip-instrument'],
  ['withdraw form', 'form.withdraw__form'],
] as const)
  test(`in the ${form} the flag keeps its space and sits centred in the field`, async ({
    page,
  }) => {
    await page.goto('/design-system');
    const states = specimen(page);
    await states.getByRole('button', { name: 'Check', exact: true }).click();
    // The real form's own input rules apply to the field inside its wrapper class.
    await states
      .locator('.states-specimen__field .tm-field')
      .evaluate((fieldEl, tag) => {
        const [name, className] = tag.split('.');
        const box = document.createElement(name!);
        box.className = className!;
        fieldEl.replaceWith(box);
        box.append(fieldEl);
      }, wrapper);
    const field = states.getByLabel('Other amount (NGN 2,000 or more)');
    const flag = states.locator('.tm-field-flag');
    await expect(flag).toBeVisible();
    const input = (await field.boundingBox())!;
    const mark = (await flag.boundingBox())!;
    const padEnd = await field.evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingInlineEnd),
    );
    // The value's area ends before the flag starts.
    expect(input.x + input.width - padEnd).toBeLessThanOrEqual(mark.x);
    // Centred on the field, whatever its height (44px in the tip card, 84px on withdraw).
    expect(
      Math.abs(input.y + input.height / 2 - (mark.y + mark.height / 2)),
    ).toBeLessThanOrEqual(1);
  });

test('a field shakes once on its first error and not on a repeat', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/design-system');
  const states = specimen(page);
  const field = states.getByLabel('Other amount (NGN 2,000 or more)');
  const check = states.getByRole('button', { name: 'Check', exact: true });
  await check.click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect.poll(() => shakes(field)).toBe(1);
  await expect.poll(() => shakes(field)).toBe(0);
  await check.click();
  await expect(states.locator('.tm-field-error')).toHaveCount(1);
  expect(await shakes(field)).toBe(0);
  // The flag sits inside the well, hidden from screen readers; the error line says it in full.
  await expect(states.locator('.tm-field-flag')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(field).toHaveAccessibleDescription(
    'Enter an amount of NGN 2,000 or more, like 2,000 or 2,500.50.',
  );
});

test('reduced motion: no shake and no settle movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/design-system');
  const states = specimen(page);
  const field = states.getByLabel('Other amount (NGN 2,000 or more)');
  await states.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(await shakes(field)).toBe(0);
  const key = saveKey(page);
  await key.click();
  await expect(key).toHaveAttribute('data-result', 'done');
  await page.mouse.move(0, 0);
  expect(await key.evaluate((el) => getComputedStyle(el).transform)).toBe(
    'none',
  );
});

test('forced colours keep every edge and every lamp visible', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/design-system');
  for (const selector of [
    '.tm-slip',
    '.tm-warning',
    '.tm-empty-well__well',
    '.tm-empty-slip__blank',
    '.tm-lamp',
    '.tm-key-result__face',
    '.tm-steps__step',
  ])
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
      selector,
    ).not.toBe('none');
});

test('at 320px a stamped slip with a long title fits, with no horizontal scroll @mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/design-system');
  const slip = specimen(page)
    .locator('.tm-slip--stamped')
    // By its body, which stays: the title is replaced below.
    .filter({ hasText: 'We couldn’t reach TipMe.' });
  await slip
    .locator('.tm-slip__title')
    .evaluate(
      (el, title) => (el.textContent = title),
      `${LONG_NAME} ${UNBROKEN_NAME}`,
    );
  expect(await fitsViewport(page)).toBe(true);
  const stamp = (await slip.locator('.tm-slip__stamp').boundingBox())!;
  const title = (await slip.locator('.tm-slip__title').boundingBox())!;
  const overlaps =
    stamp.x < title.x + title.width &&
    title.x < stamp.x + stamp.width &&
    stamp.y < title.y + title.height &&
    title.y < stamp.y + stamp.height;
  expect(overlaps).toBe(false);
  const box = (await slip.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
});
