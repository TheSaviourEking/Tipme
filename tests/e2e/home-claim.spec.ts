import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity, signUpRecipient } from './helpers';

// Home's claim field (owner, 18 Nov 2026): the button says "Claim username"; once they stop
// typing, the name is checked against the API's availability route; an available name gets a
// check, words and a lit button that nudges once. The header keeps "Get tipped".

const form = (page: Page) =>
  page.getByRole('form', { name: 'Claim your link' });
const field = (page: Page) => form(page).getByLabel('Your username');
const button = (page: Page) =>
  form(page).getByRole('button', { name: 'Claim username' });
const status = (page: Page) => form(page).locator('.home-claim__status');
const check = (page: Page) => form(page).locator('.home-claim__check');

/** The animations running on the button and its glow. */
const animations = (page: Page) =>
  button(page).evaluate(
    (node) =>
      node
        .getAnimations({ subtree: true })
        .filter((a) => a.playState !== 'finished').length,
  );

test('an available name shows a check, the words and a lit button that nudges', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  // The suite runs with reduced motion; this test sees the motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(button(page)).toBeVisible();
  await expect(check(page)).toHaveCount(0);
  // Capitals typed: the words say the lowercased name, as the hint promises.
  await field(page).pressSequentially(handle.toUpperCase(), { delay: 20 });
  await expect(status(page)).toHaveText(`@${handle} is available`);
  await expect(status(page)).toHaveAttribute('aria-live', 'polite');
  await expect(check(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute('data-ready', 'true');
  expect(await animations(page)).toBeGreaterThan(0);
  // The words carry the meaning; the mark is hidden from assistive technology.
  await expect(form(page).locator('.home-claim__mark')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  // Focus never moves.
  await expect(field(page)).toBeFocused();
  const box = await button(page).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await expectAccessible(page);
});

test('the header keeps "Get tipped"; only the claim form says "Claim username"', async ({
  page,
}) => {
  await page.goto('/');
  await expect(button(page)).toBeVisible();
  await expect(page.locator('.site-header .nav-claim')).toHaveText(
    /Get tipped/,
  );
});

test('typing asks once, after the pause, and never flashes an error', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/availability')) asked.push(request.url());
  });
  await page.goto('/');
  await field(page).pressSequentially(handle, { delay: 30 });
  await expect(status(page)).toHaveText(`@${handle} is available`);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(`/v1/handles/${handle}/availability`);
});

test('a taken name says so', async ({ page, browser }, testInfo) => {
  // Someone else has this name: a recipient signed up in their own browser.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  const { handle } = await signUpRecipient(theirs, testInfo, { live: false });
  await other.close();

  await page.goto('/');
  await field(page).fill(handle);
  await expect(status(page)).toHaveText('That username is taken.');
  await expect(check(page)).toHaveCount(0);
  await expect(button(page)).not.toHaveAttribute('data-ready', 'true');
  await expect(button(page)).toBeEnabled();
});

test('a reserved name gets the neutral words, never why', async ({ page }) => {
  await page.goto('/');
  // One of TipMe's own example people: reserved.
  await field(page).fill('tobi');
  await expect(status(page)).toHaveText('That username isn’t available.');
  await expect(form(page)).not.toContainText(/reserv/i);
  await expect(check(page)).toHaveCount(0);
});

test('a name that breaks the rule shows the format hint, without asking', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/availability')) asked.push(request.url());
  });
  await page.goto('/');
  await field(page).fill('no-dashes');
  // A short hint on screen; the field's title keeps the whole rule.
  await expect(status(page)).toHaveText('3–30 letters, numbers or underscores');
  await expect(field(page)).toHaveAttribute(
    'title',
    '3 to 30 letters, numbers or underscores. Capitals become lowercase.',
  );
  // Submitting it stays here, with the hint, rather than the browser's own bubble.
  await button(page).click();
  await expect(page).toHaveURL(/\/$/);
  expect(asked).toHaveLength(0);
});

test('a failed check says nothing and the button still goes to sign-up', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  await page.route('**/v1/handles/*/availability', (route) => route.abort());
  await page.goto('/');
  await field(page).fill(handle);
  // The request was made and failed: still nothing alarming.
  await expect(status(page)).toHaveAttribute('data-state', 'unknown');
  await expect(status(page)).toHaveText('');
  await expect(check(page)).toHaveCount(0);
  await button(page).click();
  await expect(page).toHaveURL(new RegExp(`/sign-up\\?handle=${handle}`));
});

test.describe('with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the button is lit, with no movement', async ({ page }, testInfo) => {
    const { handle } = identity(testInfo);
    await page.goto('/');
    await field(page).fill(handle);
    await expect(status(page)).toHaveText(`@${handle} is available`);
    await expect(button(page)).toHaveAttribute('data-ready', 'true');
    expect(await animations(page)).toBe(0);
    // Lit: the brand purple, not the black of the resting button.
    await expect(button(page)).toHaveCSS(
      'background-color',
      'rgb(122, 50, 249)',
    );
  });
});

test('clicking "Claim username" continues to sign-up with the name', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  await page.goto('/');
  await field(page).fill(handle);
  await expect(status(page)).toHaveText(`@${handle} is available`);
  await button(page).click();
  await expect(page).toHaveURL(new RegExp(`/sign-up\\?handle=${handle}`));
  // Business sign-up is on in the e2e stack: the name picks "Get tipped" and asks for the email.
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('on a phone the field, the words and the button stay on the screen', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await field(page).fill(handle);
  await expect(status(page)).toHaveText(`@${handle} is available`);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  for (const part of [
    form(page).locator('.home-claim__field'),
    status(page),
    button(page),
  ]) {
    const box = (await part.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  // The words sit between the field and the button.
  const words = (await status(page).boundingBox())!;
  const go = (await button(page).boundingBox())!;
  expect(words.y).toBeLessThan(go.y);
});

for (const [label, typed] of [
  ['a leading @', (handle: string) => `@${handle}`],
  ['spaces around it', (handle: string) => ` ${handle} `],
] as const) {
  test(`a name with ${label} is checked and sent to sign-up cleaned`, async ({
    page,
  }, testInfo) => {
    const { handle } = identity(testInfo);
    await page.goto('/');
    await field(page).fill(typed(handle));
    await expect(status(page)).toHaveText(`@${handle} is available`);
    await button(page).click();
    await expect(page).toHaveURL(new RegExp(`/sign-up\\?handle=${handle}$`));
    await expect(page.getByLabel('Email address')).toBeVisible();
  });
}

test('on a phone the hint never moves the button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const before = (await button(page).boundingBox())!.y;
  await field(page).fill('no-dashes');
  await expect(status(page)).toHaveText('3–30 letters, numbers or underscores');
  expect((await button(page).boundingBox())!.y).toBe(before);
});

test('a name typed before the page is ready is still checked', async ({
  page,
}, testInfo) => {
  const { handle } = identity(testInfo);
  // Hold the page's scripts, type, then let them run.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_next/static/**/*.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await field(page).fill(handle);
  release();
  await expect(status(page)).toHaveText(`@${handle} is available`);
});
