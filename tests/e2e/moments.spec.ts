import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_ORIGIN } from './stack';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';

/** A confirmed ₦2,000 tip through the public API and the pretend provider (fast seeding). */
async function apiTip(request: APIRequestContext, handle: string) {
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: { handle, amountMinor: '200000', currency: 'NGN' },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      data: { quoteId: quote.data.quoteId },
      headers: { 'idempotency-key': randomUUID() },
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
}

test('the 10th tip is celebrated without changing the fee, and a shared moment invites supporters to add to it', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  for (let i = 0; i < 9; i += 1) await apiTip(request, handle);
  await tipAsVisitor(browser, handle, { name: 'Tenth' });

  await expect(async () => {
    await page.goto('/dashboard');
    await expect(
      page.getByText('10 tips! People keep coming back to thank you.'),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await visitor.getByRole('radio', { name: '2,000 NGN' }).check();
  // Milestones grant nothing by themselves: the next supporter sees the normal 10% (ADR-0014).
  await expect(
    visitor.locator('.tip-breakdown div', { hasText: 'TipMe fee' }),
  ).toContainText('NGN 200.00');
  await expect(
    visitor.locator('.tip-breakdown div', { hasText: 'TipMe fee' }),
  ).not.toContainText('fee-free');

  const moment = page.locator('.moment-list li', { hasText: '10 tips!' });
  await moment.getByRole('button', { name: 'Share on my page' }).click();
  await expect(moment.getByText('Shared on your page')).toBeVisible();

  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(
      visitor.getByText(`Celebrating ${handle}’s 10th tip`),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await visitor.getByRole('button', { name: 'Add to the celebration' }).click();
  await expect(
    visitor.getByRole('button', { name: 'Add to the celebration' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectAccessible(visitor);
  await visitor.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(visitor.getByText(/receives NGN/)).toBeVisible();
  await visitor.getByRole('button', { name: /^Tip NGN/ }).click();
  await visitor.waitForURL(/\/mock-checkout\//);

  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  const database = await openTestDatabase();
  try {
    const { rows } = await database.pool.query(
      `SELECT count(*)::int AS n FROM tips t JOIN profiles p ON p.id = t.profile_id
        WHERE p.handle_lower = $1 AND t.celebration_moment_id IS NOT NULL`,
      [handle],
    );
    expect(rows[0].n).toBe(1);
  } finally {
    await database.close();
  }
});
