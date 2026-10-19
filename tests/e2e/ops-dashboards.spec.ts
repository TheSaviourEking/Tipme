import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { enrolOwner } from './ops-helpers';

test('the overview shows health this week against last week, and the tipping funnel', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  for (const label of [
    'Tips paid',
    'Amount tipped',
    'TipMe fees',
    'Reward cost',
  ])
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  const funnel = page.getByRole('figure', { name: /Tipping funnel/ });
  await expect(funnel).toBeVisible();
  for (const step of ['Visits', 'Amount chosen', 'Payment started', 'Paid'])
    await expect(
      funnel.getByText(step, { exact: true }).first(),
    ).toBeAttached();
  await expect(
    page.getByRole('heading', { name: 'Reliability' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
});

test('visibility shows how visitors arrive, with a text alternative for each chart', async ({
  page,
}, testInfo) => {
  // A visit from a QR code, so there is at least one channel bar.
  const visitor = await page.context().browser()!.newContext();
  const scan = await visitor.newPage();
  await scan.goto('/@ada?src=qr');
  await expect(scan).toHaveURL(/\/@ada$/);
  await visitor.close();

  await enrolOwner(page, testInfo);
  await page.goto('/ops/visibility');
  await expect(page.getByRole('heading', { name: 'Visibility' })).toBeVisible();
  const channels = page.getByRole('figure', { name: /How visitors arrive/ });
  await expect(channels).toBeVisible();
  await expect(channels.getByRole('table')).toBeAttached();
  await expect(channels.getByText('QR code').first()).toBeAttached();
  await expect(
    page.getByRole('figure', { name: /Visits per day/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Most visited pages' }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
});

test('the market page records observations with their sources and charts a metric over time', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/market');
  await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible();
  const name = `Rival${Date.now().toString(36)}${testInfo.workerIndex}`;
  for (const [day, value] of [
    ['2026-09-01', '5'],
    ['2026-10-01', '4'],
  ] as const) {
    await page.getByLabel('Date observed').fill(day);
    await page.getByLabel('Category').selectOption('competitor');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('What was measured').fill('Fee %');
    await page.getByLabel('Value (optional)').fill(value);
    await page.getByLabel('Source link').fill('https://rival.example/pricing');
    await page.getByRole('button', { name: 'Save observation' }).click();
    await expect(page.getByText('Observation saved.')).toBeVisible();
  }
  await page.getByLabel('Chart').selectOption({ label: `${name} · Fee %` });
  const chart = page.getByRole('figure', { name: `${name} · Fee % over time` });
  await expect(chart).toBeVisible();
  await expect(chart.locator('tbody tr')).toHaveCount(2);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
});
