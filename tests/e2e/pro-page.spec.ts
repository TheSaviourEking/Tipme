import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The public Pro page, built to the ProPage board (the sample from the PagePro board it replaces
// is gone). Its states are covered in tests/e2e/pro-buy.spec.ts.

test('both plans keep 10%', async ({ page }) => {
  await page.goto('/pro');
  await expect(
    page
      .getByRole('region', { name: 'TipMe Pro price' })
      .getByText('TipMe keeps 10% of each tip on both plans.', {
        exact: false,
      }),
  ).toBeVisible();
});

test('the price is never in the page’s code: it comes from the server', async () => {
  const chunks = path.join(process.cwd(), 'apps/web/.next/static/chunks');
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : entry.name.endsWith('.js')
          ? [path.join(dir, entry.name)]
          : [],
    );
  })(chunks);
  expect(files.length).toBeGreaterThan(0);
  const offer = files.filter((file) =>
    readFileSync(file, 'utf8').includes('Pro is coming soon to buy.'),
  );
  expect(offer.length).toBeGreaterThan(0);
  for (const file of offer) {
    const text = readFileSync(file, 'utf8');
    expect(text, file).not.toContain('2,500');
    expect(text, file).not.toContain('250000');
  }
});
