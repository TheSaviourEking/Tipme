import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';

/** The newest pretend email whose text matches, read from the pretend inbox (waits for it). */
async function readMail(page: Page, pattern: RegExp): Promise<string> {
  const inbox = await page.context().newPage();
  const mail = inbox.getByRole('article').filter({ hasText: pattern }).first();
  // Mail written by the worker can arrive a few seconds later: reload until it is there.
  await expect(async () => {
    await inbox.goto('/dev/inbox');
    await expect(mail).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 25_000 });
  const text = (await mail.textContent()) ?? '';
  await inbox.close();
  return text;
}

test('the notification panel stays fully on screen at every width', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  const bell = page.getByRole('button', { name: /^Notifications,/ });
  for (const [width, height] of [
    [320, 568],
    [360, 800],
    [390, 844],
    [600, 800],
    [768, 1024],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await bell.click();
    const panel = page.locator('#notification-list');
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box, `panel at ${width}px`).not.toBeNull();
    expect(box!.x, `left edge at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `right edge at ${width}px`).toBeLessThanOrEqual(
      width,
    );
    const pageWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(pageWidth, `no sideways scroll at ${width}px`).toBeLessThanOrEqual(
      width,
    );
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});

test('the unread count stays on the bell on a phone', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.setViewportSize({ width: 360, height: 800 });
  const firstPoll = page.waitForResponse((response) =>
    response.url().includes('/v1/me/notifications'),
  );
  await page.goto('/dashboard');
  await firstPoll;
  await tipAsVisitor(browser, handle, { name: 'Bola' });
  const bell = page.getByRole('button', { name: /^Notifications, [1-9]/ });
  await expect(bell).toBeVisible({ timeout: 25_000 });
  const bellBox = (await bell.boundingBox())!;
  const countBox = (await page.locator('.bell__count').boundingBox())!;
  expect(countBox.x).toBeGreaterThanOrEqual(bellBox.x);
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(
    bellBox.x + bellBox.width,
  );
  expect(countBox.y).toBeGreaterThanOrEqual(bellBox.y);
  expect(countBox.y + countBox.height).toBeLessThanOrEqual(
    bellBox.y + bellBox.height,
  );
});

test('a recipient is told about a confirmed tip, verifies an email and is emailed the next tip', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  // Notifications that already exist when the page opens count as seen, so wait for the first
  // poll before tipping: only a tip that arrives afterwards pops up.
  const firstPoll = page.waitForResponse((response) =>
    response.url().includes('/v1/me/notifications'),
  );
  await page.goto('/dashboard');
  await firstPoll;
  await expect(
    page.getByRole('button', { name: 'Notifications, none unread' }),
  ).toBeVisible();

  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await expect(
    page.getByRole('status').filter({ hasText: 'You got a tip' }),
  ).toBeVisible({ timeout: 25_000 });
  // The first tip is also a moment ("Your first tip!"), which the worker adds just after.
  await expect(
    page.getByRole('button', { name: 'Notifications, 2 unread' }),
  ).toBeVisible({ timeout: 25_000 });
  await page.getByRole('button', { name: 'Notifications, 2 unread' }).click();
  // The toast may still be showing the same words: look in the panel.
  const panel = page.locator('#notification-list');
  await expect(panel.getByText('NGN 1,800.00 from Bola')).toBeVisible();
  await expect(
    panel.getByText('Your first tip! Someone noticed your work.'),
  ).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Notifications, none unread' }),
  ).toBeVisible();

  // A domain unique to this test: the pretend inbox shows only the first letter and the domain.
  const domain = `${handle.replace('_', '-')}.example`;
  const email = `kemi@${domain}`;
  await page.goto('/dashboard/settings');
  await page.getByLabel('New email address').fill(email);
  await page.getByRole('button', { name: 'Send code to new address' }).click();
  await expect(page.getByText(/We sent a code to/)).toBeVisible();
  const mail = await readMail(
    page,
    new RegExp(`k•••@${domain}.*Confirm your new TipMe email`, 's'),
  );
  const code = /\b(\d{6})\b/.exec(mail)?.[1] ?? '';
  await page.getByLabel('Code sent to the new address').fill(code);
  await page.getByRole('button', { name: 'Change email' }).click();
  await expect(page.getByText(/Your email was changed/)).toBeVisible();

  await tipAsVisitor(browser, handle, { name: 'Chidi' });
  await readMail(
    page,
    new RegExp(`k•••@${domain}.*You got a ₦1,800 tip on TipMe.*Chidi`, 's'),
  );
});

test('the settings email section lists security and account mail as always sent', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#emails');
  const section = page.locator('#emails');
  await expect(
    section.getByText(/always reach you: sign-in codes, security warnings/),
  ).toBeVisible();
  const guides = section.getByLabel(
    'Send me guides and suggestions for getting started',
  );
  await expect(guides).toBeChecked();
  await guides.uncheck();
  await section.getByRole('button', { name: /Save/ }).click();
  await page.reload();
  await expect(
    page
      .locator('#emails')
      .getByLabel('Send me guides and suggestions for getting started'),
  ).not.toBeChecked();
});

test('Settings shows "Hide who tipped and how much in pop-ups" off and "Sound for new tips" on, and saving keeps them after a reload', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#popups');
  const card = page.locator('#popups');
  await expect(
    card.getByRole('heading', { name: 'Pop-ups and sound' }),
  ).toBeVisible();
  const hide = card.getByLabel('Hide who tipped and how much in pop-ups');
  const sound = card.getByLabel('Sound for new tips');
  await expect(hide).not.toBeChecked();
  await expect(sound).toBeChecked();
  await expect(
    card.getByText(
      'For shared screens and shop counters. Your tips list still shows the details.',
    ),
  ).toBeVisible();
  await expect(
    card.getByText(
      'Plays once for a new paid tip while TipMe is in a background tab.',
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await hide.check();
  await sound.uncheck();
  await card.getByRole('button', { name: 'Save pop-ups and sound' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  const again = page.locator('#popups');
  await expect(
    again.getByLabel('Hide who tipped and how much in pop-ups'),
  ).toBeChecked();
  await expect(again.getByLabel('Sound for new tips')).not.toBeChecked();
  // The emails card saving later keeps these two as they are.
  await page
    .locator('#emails')
    .getByLabel('Tell me about milestones and rewards')
    .uncheck();
  await page
    .locator('#emails')
    .getByRole('button', { name: 'Save notifications' })
    .click();
  await expect(page.locator('#emails').getByRole('status')).toHaveText(
    'Saved.',
  );
  await page.reload();
  await expect(
    page
      .locator('#popups')
      .getByLabel('Hide who tipped and how much in pop-ups'),
  ).toBeChecked();
});
