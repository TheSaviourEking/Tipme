import { expect, test } from '@playwright/test';
import { identity, signInWithEmail } from './helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Home, rebuilt to the ScreenHome board (docs/design/redesign/boards/ScreenHome.dc.html).

test('home switches between getting tipped and tipping with one lever', async ({
  page,
}) => {
  await page.goto('/');
  const lever = page.getByRole('radiogroup', { name: 'Show the steps for' });
  const tipped = lever.getByRole('radio', { name: 'If you get tipped' });
  const tipping = lever.getByRole('radio', { name: "If you're tipping" });
  await expect(tipped).toBeChecked();
  const steps = page.locator('main');
  for (const step of ['Make it yours', 'Share it anywhere', 'Get your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Scan or tap')).toBeHidden();
  await expect(steps.getByText('Say your thanks')).toBeHidden();

  await tipping.click();
  await expect(tipping).toBeChecked();
  for (const step of ['Scan or tap', 'Choose an amount', 'Say your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Make it yours')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Tip in three steps.' }),
  ).toBeVisible();

  // One tab stop; the arrow keys move the choice with focus.
  await tipping.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tipped).toBeChecked();
  await expect(tipped).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Tipped in three steps.' }),
  ).toBeVisible();
});

test('home states the fee and the minimum plainly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('TipMe keeps 10% of each tip')).toBeVisible();
  await expect(page.getByText('The smallest tip is ₦2,000.')).toBeVisible();
  expect(await page.content()).not.toContain('₦1,000');
});

test('home names global payments, as the owner decided', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-lede')).toContainText(
    'global payments (USD, EUR, GBP, NGN, Stablecoins)',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let People Celebrate You for the things you do.',
  );
});

test('the hero tip demo uses the standard amounts', async ({ page }) => {
  await page.goto('/');
  // The example card is a picture of a tip page, so it is hidden from assistive technology.
  const demo = page.locator('.home-demo__main');
  for (const amount of ['₦2,000', '₦5,000', '₦10,000'])
    await expect(demo.getByText(amount, { exact: true })).toBeVisible();
  // The people on it are labelled as examples.
  await expect(page.getByText(/examples, not real people/i)).toBeVisible();
});

test('the handle typed on Home is waiting, lowercased, at the handle step of sign-up', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  // Capitals typed on Home: sign-up lowercases them, as the handle rule requires.
  const typed = who.handle.toUpperCase();
  await page.goto('/');
  const form = page.getByRole('form', { name: 'Claim your link' });
  await form.getByLabel('Your handle').fill(typed);
  await form.getByRole('button', { name: 'Claim your username' }).click();
  await expect(page).toHaveURL(/\/sign-up\?handle=/);
  // Through the email and the code (the handle must survive both) to the handle step.
  await signInWithEmail(page, who.email, page.url());
  const field = page.getByLabel('Handle');
  await expect(field).toHaveValue(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  // Still editable.
  await field.fill(`${who.handle}_x`);
  await expect(field).toHaveValue(`${who.handle}_x`);
});

test('a handle in the sign-up link that breaks the handle rule prefills nothing', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up?handle=not%20a-handle!');
  await expect(page.getByLabel('Handle')).toBeVisible();
  await expect(page.getByLabel('Handle')).toHaveValue('');
});

test('the claim field says capitals become lowercase', async ({ page }) => {
  await page.goto('/');
  const field = page.getByLabel('Your handle');
  await expect(field).toHaveAttribute('title', /lowercase/);
  expect(
    await field.evaluate((input) => getComputedStyle(input).textTransform),
  ).toBe('lowercase');
});

// The hero's example cards: centred on a phone; alive, flippable and hiding a thank-you wherever
// there is a mouse (the owner's easter egg, 3 Nov 2026). They stay decorative.

test(
  'the example card is centred on a phone @mobile',
  { tag: '@mobile' },
  async ({ page }) => {
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const box = await page.locator('.home-demo__main').boundingBox();
      expect(box).not.toBeNull();
      const centre = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      expect(Math.abs(centre - width / 2), `${width}px`).toBeLessThanOrEqual(2);
      expect(
        await page
          .locator('.home-demo__caption')
          .evaluate((node) => getComputedStyle(node).textAlign),
      ).toBe('center');
    }
  },
);

const ready = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await expect(page.locator('.home-flip').first()).toHaveAttribute(
    'data-ready',
    'true',
  );
};

test('clicking an example card flips it to a note labelled Example, and again flips it back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const tobi = page.locator('.home-demo__card--tobi');
  await expect(tobi).toHaveAttribute('data-flipped', 'false');
  // Only the card's left edge is clear of the front card.
  await tobi.click({ position: { x: 24, y: 110 } });
  await expect(tobi).toHaveAttribute('data-flipped', 'true');
  const back = tobi.locator('.home-flip__back');
  await expect(back.getByText('Example', { exact: true })).toBeVisible();
  await expect(back).toContainText('Tobi');
  await tobi.click({ position: { x: 24, y: 110 } });
  await expect(tobi).toHaveAttribute('data-flipped', 'false');
});

test('pressing the example Tip says thank you for the chosen amount, makes no request, then settles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const ada = page.locator('.home-demo__main');
  await ada.getByText('₦10,000', { exact: true }).click();
  await ada.getByText('Tip ₦10,000').click();
  await expect(ada).toHaveAttribute('data-flipped', 'true');
  await expect(ada.getByText('Thank you for the ₦10,000!')).toBeVisible();
  // Page chrome (link prefetches, the page's own vitals beacon) may talk; nothing about a tip does.
  expect(
    requests.filter(
      (url) => url.startsWith(API_ORIGIN) && !url.endsWith('/v1/vitals'),
    ),
  ).toEqual([]);
  expect(page.url()).toBe(`${WEB_ORIGIN}/`);
  await expect(ada).toHaveAttribute('data-flipped', 'false', {
    timeout: 10_000,
  });
  await ada.getByText('Tip ₦10,000').click();
  await expect(ada.getByText('Thank you for the ₦10,000!')).toBeVisible();
});

// The owner looked in a laptop window narrower than the three-card spread (3 Nov 2026): the lone
// card still answers a mouse there.
test('in a narrower desktop window the lone example card still drifts and says thank you', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  // The suite runs with reduced motion; the drift is only for those who welcome it.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await ready(page);
  const ada = page.locator('.home-demo__main');
  expect(
    await ada.evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('home-drift');
  // A drifting card never holds still for a test's click, so the Tip is pressed with it still.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ada.getByText('Tip ₦5,000').click();
  await expect(ada).toHaveAttribute('data-flipped', 'true');
  await expect(ada.getByText('Thank you for the ₦5,000!')).toBeVisible();
});

test('with reduced motion the example cards have no running animation, and without it they do', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const running = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === 'running' &&
              (a.effect as KeyframeEffect | null)?.target?.closest(
                '.home-demo',
              ),
          ).length,
    );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  expect(await running()).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(running).toBeGreaterThan(0);
});

test('the example cards hold nothing to focus, so assistive technology skips them cleanly', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  await expect(page.locator('.home-demo__stack')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(
    page
      .locator('.home-demo__stack')
      .locator(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]',
      ),
  ).toHaveCount(0);
});
