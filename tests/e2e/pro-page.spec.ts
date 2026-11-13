import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The public Pro page, built to the ProPage board (the sample from the PagePro board it replaces
// is gone). Its states are covered in tests/e2e/pro-buy.spec.ts.

// The owner's pricing, 12 Nov 2026: Pro keeps 5% of each tip instead of Free's 7%.
test('Pro keeps 5% instead of 7%, said in the offer, the Free list and the FAQ', async ({
  page,
}) => {
  await page.goto('/pro');
  await expect(
    page
      .getByRole('region', { name: 'TipMe Pro price' })
      .getByText('On Pro, TipMe keeps 5% of each tip instead of 7%.', {
        exact: false,
      }),
  ).toBeVisible();
  const main = page.getByRole('main');
  await expect(
    main.getByText(
      'Receiving tips, with no monthly fee: TipMe keeps 7% of each tip',
    ),
  ).toBeVisible();
  await expect(
    main.getByText('On Pro, TipMe keeps 5% of each tip instead of 7%, processing included.', {
      exact: false,
    }),
  ).toBeAttached();
  await expect(main).not.toContainText('on both plans.');
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
