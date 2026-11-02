import { expect, test } from '@playwright/test';
import { E2E_DATABASE_URL } from './stack';

async function countEvents(name: string, handle: string): Promise<number> {
  const ops = await import('../../packages/database/dist/index.js');
  const handleDb = ops.createDatabase(E2E_DATABASE_URL, { max: 1 });
  try {
    const result = await handleDb.pool.query(
      'SELECT count(*)::int AS n FROM analytics_events WHERE name = $1 AND handle = $2',
      [name, handle],
    );
    return result.rows[0].n as number;
  } finally {
    await handleDb.close();
  }
}

test('a QR scan is counted anonymously and the address is cleaned', async ({
  page,
}) => {
  const before = await countEvents('qr_scanned', 'ada');
  await page.goto('/@ada?src=qr');
  await expect(page).toHaveURL(/\/@ada$/);
  await expect
    .poll(() => countEvents('qr_scanned', 'ada'), { timeout: 10_000 })
    .toBeGreaterThan(before);
});

test('with Global Privacy Control on, the page sends no analytics at all', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true });
  });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/events')) sent.push(request.url());
  });
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
});

test('the starting NGN 2,000 is not counted as a choice; tapping an amount is', async ({
  page,
}) => {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/events'))
      sent.push(request.postData() ?? '');
  });
  await page.goto('/@ada');
  await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeChecked();
  // Let the page's own events (the view) go out first.
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(sent.some((body) => body.includes('amount_selected'))).toBe(false);
  await page.getByRole('radio', { name: '5,000 NGN' }).click();
  await expect
    .poll(() => sent.filter((body) => body.includes('amount_selected')).length)
    .toBe(1);
});
