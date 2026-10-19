import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';

test('a recipient reads their week and shares it without supporters’ names', async ({
  page,
  browser,
  request,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: undefined,
      configurable: true,
    });
  });
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Zed Q.',
    message: 'Thank you!',
  });
  const run = await request.post(
    'http://127.0.0.1:4100/v1/dev/jobs/weekly-report',
    {
      data: {
        handle,
        isoWeek: await page.evaluate(() => {
          const now = new Date(Date.now() + 3600_000);
          const day = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
          );
          const weekday = day.getUTCDay() || 7;
          day.setUTCDate(day.getUTCDate() + 4 - weekday);
          const week = Math.ceil(
            ((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86400000 +
              1) /
              7,
          );
          return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
        }),
      },
    },
  );
  expect(run.ok()).toBe(true);
  await page.goto('/dashboard');
  await page.getByRole('link', { name: /Your week/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Your week',
  );
  await expect(page.getByText('NGN 1,870.00').first()).toBeVisible();
  await expect(page.getByText('Most frequent supporter: Zed Q.')).toBeVisible();
  await expect(page.getByText('Only you can see this')).toBeVisible();
  await expectAccessible(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share my week' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^tipme-week-\d{4}-W\d{2}\.png$/,
  );
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await fitsViewport(page)).toBe(true);
});
