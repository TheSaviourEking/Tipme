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
  // The owner, 3 Nov 2026: "We need this off 'Examples, not real people.' the website."
  await expect(page.getByText(/examples, not real people/i)).toHaveCount(0);
});

test('the individuals page names creators and streamers and keeps one call to claim', async ({
  page,
}) => {
  await page.goto('/for-creators');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'People already want to tip you.',
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

// The e2e stack runs with TipMe for businesses on (playwright.config.ts). The coming-soon interest
// form it shows while off is tested on a stand-in stack in business-setup.spec.ts.
test('with businesses on, the businesses page invites people to create one', async ({
  page,
}) => {
  await page.goto('/for-businesses');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let your customers tip your team.',
  );
  await expect(
    page.getByRole('link', { name: 'Create your business' }),
  ).toHaveAttribute('href', '/dashboard/business/apply');
  await expect(page.getByLabel('Work email')).toHaveCount(0);
  const main = page.getByRole('main');
  await expect(main).not.toContainText(/₦|\bNGN\b|launch date|\bper month\b/i);
  await expect(main).not.toContainText(/20\d\d/);
  await expect(main).not.toContainText(/approved|licensed|regulated/i);
});

test('the businesses page is centred: the text and the card sit as one block in the middle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/for-businesses');
  const hero = page.locator('.business-hero');
  const parts = hero.locator('> *').filter({ visible: true });
  const text = parts.first();
  const card = parts.last();
  await expect(parts).toHaveCount(2);
  const [t, c] = [(await text.boundingBox())!, (await card.boundingBox())!];
  // Horizontally: the space left of the text matches the space right of the card.
  const left = t.x;
  const right = 1440 - (c.x + c.width);
  expect(Math.abs(left - right)).toBeLessThan(24);
  // Vertically: the block sits mid-way between the header and the bottom of the window.
  const header = (await page.locator('header').first().boundingBox())!;
  const top = Math.min(t.y, c.y) - (header.y + header.height);
  const bottom = 900 - Math.max(t.y + t.height, c.y + c.height);
  expect(Math.abs(top - bottom)).toBeLessThan(64);
});

// The owner, 14 Nov 2026: "We should use 'Tips' instead of 'thanks'". Where "thanks" meant the
// money, the public pages now say tips; gratitude and the tagline stay.
test('the public pages say tips, not thanks, where they mean the money', async ({
  page,
}) => {
  const replaced =
    /Get your thanks|Say your thanks|want to thank you|thank your team|thank them with a tip|thank the people|start receiving thanks|you want to thank\b/i;
  for (const [path, kept] of [
    ['/', 'Get your tips'],
    ['/for-creators', 'People already want to tip you.'],
    ['/for-businesses', 'Let your customers tip your team.'],
  ] as const) {
    await page.goto(path);
    const main = page.getByRole('main');
    await expect(main).toContainText(kept);
    await expect(main).not.toContainText(replaced);
  }
});
