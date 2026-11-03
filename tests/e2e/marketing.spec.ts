import { expect, test } from '@playwright/test';

// Individuals and businesses, rebuilt to the PageCreators and PageBusinesses boards
// (docs/design/redesign/boards).

test('the individuals page shows a counter, a stream and a post', async ({
  page,
}) => {
  await page.goto('/for-creators');
  const lever = page.getByRole('radiogroup', { name: 'Where you meet people' });
  const scenes = {
    'On a counter': 'scene-counter',
    'On stream': 'scene-stream',
    'In a post': 'scene-post',
  } as const;
  for (const [label, scene] of Object.entries(scenes)) {
    await lever.getByRole('radio', { name: label }).click();
    await expect(lever.getByRole('radio', { name: label })).toBeChecked();
    await expect(page.getByTestId(scene)).toBeVisible();
    for (const other of Object.values(scenes).filter((id) => id !== scene))
      await expect(page.getByTestId(other)).toHaveCount(0);
  }
});

test('pressing Tip on the example drops a labelled example note', async ({
  page,
}) => {
  await page.goto('/for-creators');
  const tray = page.getByTestId('example-tray');
  await expect(tray).toContainText('Example');
  await expect(tray.getByTestId('example-slip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tip ₦2,000' }).click();
  await expect(tray.getByTestId('example-slip')).toHaveCount(1);
  await expect(tray.getByTestId('example-slip')).toContainText('₦2,000');
  await expect(page.getByText('Examples, not real people.')).toBeVisible();
});

test('the individuals page names creators and streamers and keeps one call to claim', async ({
  page,
}) => {
  await page.goto('/for-creators');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'People already want to thank you.',
  );
  await expect(
    page.getByText(/Barbers, drivers, streamers, creators/),
  ).toBeVisible();
  const claim = page.getByRole('link', { name: 'Claim your username' });
  await expect(claim.first()).toHaveAttribute('href', '/sign-up');
  for (const link of await claim.all())
    await expect(link).toHaveAttribute('href', '/sign-up');
  const content = await page.content();
  expect(content).not.toContain('₦1,000');
});

test('the businesses page only registers interest', async ({ page }) => {
  await page.goto('/for-businesses');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'TipMe for businesses is on its way.',
  );
  await page.getByLabel('Work email').fill('owner@example.com');
  await page.getByRole('button', { name: "Tell me when it's ready" }).click();
  await expect(page.getByText("You're on the list.")).toBeVisible();
  const main = page.getByRole('main');
  await expect(main).not.toContainText(/₦|\bNGN\b|launch date|\bper month\b/i);
  await expect(main).not.toContainText(/20\d\d/);
});
