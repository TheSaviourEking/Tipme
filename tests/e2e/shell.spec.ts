import { expect, test } from '@playwright/test';

test('marketing is responsive, keyboard accessible and clearly a preview', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('TipMe — A little thanks goes a long way');
  // The line breaks are <br>, so the accessible name has no space at those joins.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /Surprise the\s*people around,\s*by tipping them\./,
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('marketing.png'),
    fullPage: true,
  });
});

test('profile supports keyboard amount selection, validation and a server quote', async ({
  page,
}, testInfo) => {
  const posts: string[] = [];
  const events: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    // Anonymous analytics and web vitals are checked separately: they never carry the message.
    if (path === '/v1/events' || path === '/v1/vitals')
      events.push(request.postData() ?? '');
    else posts.push(path);
  });
  await page.goto('/@ada');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Ada Okafor',
  );
  await expect(page.locator('[data-profile-card]')).toBeVisible();
  await expect(
    page.getByRole('img', {
      name: 'Portrait of Ada Okafor, a fictional demo recipient',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Tip/ }).click();
  await expect(
    page.getByText('Choose an amount or enter your own.'),
  ).toBeVisible();
  const first = page.getByRole('radio', { name: '1,000 NGN' });
  await first.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeChecked();
  await page.getByRole('radio', { name: 'Other amount' }).check();
  const custom = page.getByLabel('Your amount (NGN)');
  await custom.fill('0');
  await page.getByRole('button', { name: /^Tip/ }).click();
  await expect(
    page.getByText(
      'Enter an amount of NGN 1,000 or more, like 1,000 or 2,500.50.',
    ),
  ).toBeVisible();
  await custom.fill('1234.50');
  await page
    .getByLabel('Personal message (optional)')
    .fill('Thank you for making this easier.');
  await expect(
    page.getByText(/^Ada receives NGN [\d,]+\.\d\d after fees$/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Tip NGN 1,234\.50/ }),
  ).toBeEnabled();
  // Quoting sends only the amount: no tip is created and the message stays in the page.
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every((path) => path === '/v1/tip-quotes')).toBe(true);
  expect(events.some((body) => body.includes('Thank you'))).toBe(false);
  expect(page.url()).not.toContain('Thank');
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('profile.png'),
    fullPage: true,
  });
});

test('unknown profiles are unavailable and mock metadata is safe', async ({
  page,
}) => {
  await page.goto('/@ada');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/@ada$/,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    /Ada Okafor/,
  );
  await page.goto('/@not-a-person');
  await expect(
    page.getByRole('heading', { name: 'This page isn’t available right now' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tip/ })).toHaveCount(0);
});
