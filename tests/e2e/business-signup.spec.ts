import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { expectNoSignUp, recordNavigations } from './business-signup-fixtures';
import { API_ORIGIN } from './stack';

// Business sign-up, Task D3: the "Get tipped" / "For businesses" fork and the four business
// steps. The e2e stack runs with BUSINESS_SIGNUP_ENABLED on (playwright.config.ts).

// A sign-up plus four steps is longer than one sign-up's budget.
test.slow();

test('home line → For businesses → four steps → waiting on the business, with no page and never /sign-up', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  const slug = `suya-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Start with your business' })
    .click();
  await page.waitForURL(/\/sign-up\?for=business$/);
  // The link picked the path: no question, the business's own four steps.
  const steps = page.getByRole('list', { name: 'Signing up your business' });
  await expect(steps).toBeVisible();
  await expect(steps.getByRole('listitem')).toHaveText([
    'Your email',
    'The code',
    'Your business',
    'First location',
  ]);
  await expectAccessible(page);

  await signInWithEmail(page, who.email, null);
  const visited = recordNavigations(page);
  await page.getByLabel('Business name').fill('Tunde’s Suya Spot');
  await page.getByLabel('Address on TipMe', { exact: true }).fill(slug);
  await expect(page.getByText(`/b/${slug}`)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Your name').fill('Tunde Bakare');
  // The confirmed email is the contact for TipMe.
  await expect(page.locator('.auth-card').getByText(who.email)).toBeVisible();
  await page.getByLabel('Location name').fill('Allen Avenue');
  await page
    .getByLabel('Location address on TipMe', { exact: true })
    .fill('allen');
  await page.getByLabel('Street address').fill('14 Allen Avenue, Ikeja, Lagos');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Send to TipMe' }).click();

  await page.waitForURL(/\/dashboard\/business\?business=[0-9a-f-]{36}$/);
  await expect(
    page
      .getByRole('main')
      .getByText('Waiting for TipMe to check your business.'),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoSignUp(visited);
  // Still no page of their own.
  expect((await page.request.get(`${API_ORIGIN}/v1/me/profile`)).status()).toBe(
    404,
  );
});

test('home’s “Get tipped” runs today’s three steps to the welcome', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await page.goto('/');
  const main = page.getByRole('main');
  await main.getByLabel('Your handle').fill(who.handle);
  await main.getByRole('button', { name: 'Get tipped' }).click();
  await page.waitForURL(/\/sign-up\?handle=/);
  await expect(
    page
      .getByRole('list', { name: 'Creating your page' })
      .getByRole('listitem'),
  ).toHaveText(['Your email', 'The code', 'Your handle']);
  await signInWithEmail(page, who.email, null);
  await expect(page.getByLabel('Handle')).toHaveValue(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
});

test('the fork asks first; “Get tipped” runs the same three steps', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await page.goto('/sign-up');
  const fork = page.getByRole('radiogroup', {
    name: 'What brings you to TipMe?',
  });
  await expect(fork).toBeVisible();
  await expect(
    page.getByText(
      'Invited to work somewhere? Open the link in your invitation instead.',
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await fork.getByRole('radio', { name: /Get tipped/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page
      .getByRole('list', { name: 'Creating your page' })
      .getByRole('listitem'),
  ).toHaveText(['Your email', 'The code', 'Your handle']);
  await signInWithEmail(page, who.email, null);
  await page.getByLabel('Handle').fill(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
});
