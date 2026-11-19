import { expect, test, type Page, type Route } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio's publish gate (styles plan Task 14, PR 5a; spec §12.1): while the design check
// lists issues, Publish reads "Publish · N to fix", is aria-disabled but focusable, and opens
// "Your page can’t be published yet" with the fixes. When the check passes it opens "Publish your
// page?" with the summary. The server's issues (422) replace the editor's. There is no "publish
// anyway". The `page_studio` switch is on in the e2e stack.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

// Sign-up, saves and the public page's revalidation take a while on a busy machine.
test.describe.configure({ timeout: 120_000 });

async function setPlan(handle: string, plan: 'pro' | 'free') {
  await sql(
    `UPDATE profiles SET staff_pro = $2, plan = $3 WHERE handle_lower = $1`,
    [handle, plan === 'pro', plan],
  );
}

async function savedStudio(page: Page) {
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  return (await mine.json()).data;
}

async function saveDraft(page: Page, draft: Record<string, unknown>) {
  const mine = await savedStudio(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: mine.rev, draft: { ...mine.draft, ...draft } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

const EMPTY_QUOTES = [
  { id: 'e2epub01', kind: 'quote', text: '' },
  { id: 'e2epub02', kind: 'quote', text: '' },
];
const FIVE_BLOCKS = [
  { id: 'e2epub11', kind: 'text', variant: 'heading', text: 'New single' },
  { id: 'e2epub12', kind: 'quote', text: 'Sang like home.' },
  {
    id: 'e2epub13',
    kind: 'text',
    variant: 'paragraph',
    text: 'Out on Friday.',
  },
  { id: 'e2epub14', kind: 'quote', text: 'Every tip goes to the band.' },
  { id: 'e2epub15', kind: 'text', variant: 'paragraph', text: 'Thank you.' },
];

const bar = (page: Page) => page.locator('.pst-bar');
const publishButton = (page: Page) =>
  bar(page).getByRole('button', { name: /^Publish/ });
const blocked = (page: Page) =>
  page.getByRole('dialog', { name: 'Your page can’t be published yet' });
const confirm = (page: Page) =>
  page.getByRole('dialog', { name: 'Publish your page?' });
const card = (page: Page, name: string) =>
  page
    .getByRole('radiogroup', { name: 'Style', exact: true })
    .getByRole('radio', { name: new RegExp(`^${name},`) });

/**
 * Opens the gate from Publish by keyboard. Playwright counts aria-disabled as disabled and won't
 * click it; a person can, and that is the point (§12.1), so focus it and press Enter.
 */
async function openGate(page: Page) {
  await publishButton(page).focus();
  await expect(publishButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
}

async function openEditor(page: Page) {
  await page.goto('/dashboard/studio');
  await expect(
    page.getByRole('heading', { name: 'Page Studio', level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(publishButton(page)).toBeVisible();
}

test('with issues, Publish is aria-disabled, stays focusable and opens "Your page can’t be published yet" with the fixes', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: EMPTY_QUOTES });
  await openEditor(page);
  const button = publishButton(page);
  await expect(button).toHaveText('Publish · 2 to fix');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  // Not the native attribute: that would take it out of the Tab order.
  await expect(button).not.toHaveAttribute('disabled');
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = blocked(page);
  await expect(dialog).toBeVisible();
  // Described by its intro alone, not the whole list.
  await expect(dialog).toHaveAccessibleDescription(
    '2 things to fix first. Your draft is saved.',
  );
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByText('A quote is empty')).toHaveCount(2);
  await expect(
    dialog.getByRole('button', { name: 'Remove the block' }),
  ).toHaveCount(2);
  await dialog
    .getByRole('button', { name: 'Remove the block' })
    .first()
    .click();
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(button).toHaveText('Publish · 1 to fix');

  // Escape closes it, and focus is back on Publish.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  // A pointer opens it too (force: Playwright won't click an aria-disabled button by itself).
  await button.click({ force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(button).toBeFocused();
  // Nothing was published.
  expect((await savedStudio(page)).published).toBeNull();
});

test('a Free person with Stage sees the pro-only issue with "Choose a free style" and "See Pro"', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await saveDraft(page, { style: 'stage', blocks: [] });
  await setPlan(who.handle, 'free');
  await openEditor(page);
  await expect(publishButton(page)).toHaveText('Publish · 1 to fix');
  await openGate(page);

  const dialog = blocked(page);
  await expect(dialog.getByText('Stage is a Pro style')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'See Pro' })).toHaveAttribute(
    'href',
    '/pro',
  );
  await dialog.getByRole('button', { name: 'Choose a free style' }).click();
  // The dialog gives way to the style cards.
  await expect(dialog).toHaveCount(0);
  await expect(card(page, 'Stage')).toBeFocused();
});

test('after a 422 the dialog shows the server’s issues, not the client’s', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  let asked = 0;
  await page.route(`${API_ORIGIN}/v1/me/studio/publish`, (route) => {
    asked += 1;
    return route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'STUDIO_DESIGN_CHECK_FAILED',
          message:
            'Your page can’t be published yet. Fix what the design check lists first; your draft is saved.',
          reference: 'e2e-publish-422',
          issues: [
            {
              rule: 'long-word',
              severity: 'error',
              at: { row: '', block: 'e2epub11' },
              message: 'Our servers found a word too long for a phone',
              fixes: [],
            },
          ],
        },
      }),
    });
  });
  await openEditor(page);
  // The editor's own check passes.
  await expect(publishButton(page)).toHaveText('Publish');
  await expect(publishButton(page)).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await openGate(page);
  await confirm(page)
    .getByRole('button', { name: 'Publish', exact: true })
    .click();

  const dialog = blocked(page);
  await expect(dialog).toBeVisible();
  expect(asked).toBe(1);
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(
    dialog.getByText('Our servers found a word too long for a phone'),
  ).toBeVisible();
  await expect(publishButton(page)).toHaveText('Publish · 1 to fix');
  await page.keyboard.press('Escape');
  await expect(publishButton(page)).toBeFocused();
  // Until the next edit, the server's issues stand.
  await openGate(page);
  await expect(
    blocked(page).getByText('Our servers found a word too long for a phone'),
  ).toBeVisible();
});

test('when the check passes, "Publish your page?" shows "Clear · Blue · Auto · Your cover · 5 blocks" and "Design check: N of N pass"; on success the status reads "Published" and the public page shows the style', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  await saveDraft(page, {
    style: 'clear',
    accent: null,
    mode: 'auto',
    cover: 'yours',
    blocks: FIVE_BLOCKS,
  });
  await openEditor(page);
  await expect(bar(page).getByRole('status')).toHaveText(
    'Saved · not published',
  );
  await openGate(page);

  const dialog = confirm(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Clear · Blue · Auto · Your cover · 5 blocks'),
  ).toBeVisible();
  await expect(
    dialog.getByText(/^Design check: (\d+) of \1 pass$/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bar(page).getByRole('status')).toHaveText('Published');
  await expect(publishButton(page)).toBeFocused();
  expect((await savedStudio(page)).published?.style).toBe('clear');

  await expect(async () => {
    await page.goto(`/@${who.handle}`);
    await expect(page.locator('.studio[data-style="clear"]')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'New single' })).toBeVisible();
});

test('there is no publish-anyway control', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: EMPTY_QUOTES.slice(0, 1) });
  await openEditor(page);
  const anyway = page.getByRole('button', { name: /anyway/i });
  const anywayLink = page.getByRole('link', { name: /anyway/i });
  await expect(anyway).toHaveCount(0);
  await openGate(page);
  const dialog = blocked(page);
  await expect(dialog).toBeVisible();
  await expect(anyway).toHaveCount(0);
  await expect(anywayLink).toHaveCount(0);
  await expect(dialog).not.toContainText(/anyway/i);
  // The last fix turns it into the question, which has no such control either.
  await dialog.getByRole('button', { name: 'Remove the block' }).click();
  await expect(confirm(page)).toBeVisible();
  await expect(anyway).toHaveCount(0);
  await expect(anywayLink).toHaveCount(0);
  await expect(confirm(page)).not.toContainText(/anyway/i);
});

/** Answers the next publish with `fulfil`, the rest as usual. */
async function answerPublish(
  page: Page,
  fulfil: (route: Route) => Promise<void>,
) {
  await page.route(`${API_ORIGIN}/v1/me/studio/publish`, fulfil, {
    times: 1,
  });
}

const refusal = (status: number, code: string) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code, message: code, reference: 'e2e' } }),
});

test('a publish that can’t be confirmed says so, and never that it wasn’t published', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  await answerPublish(page, (route) => route.abort('internetdisconnected'));
  await openEditor(page);
  await openGate(page);
  const dialog = confirm(page);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'We couldn’t confirm it was published. Check your connection, then reload to see.',
  );
  await expect(dialog).not.toContainText(/wasn’t published/);
});

test('with Page Studio switched off, Publish says Studio isn’t available right now', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  await answerPublish(page, (route) =>
    route.fulfill(refusal(404, 'NOT_FOUND')),
  );
  await openEditor(page);
  await openGate(page);
  const dialog = confirm(page);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Page Studio isn’t available right now.',
  );
  await expect(dialog).not.toContainText(/try again/i);
});

test('a draft saved in another tab: the dialog says so, and “Show the latest” brings it back', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  await answerPublish(page, (route) =>
    route.fulfill(refusal(409, 'STUDIO_DRAFT_STALE')),
  );
  await openEditor(page);
  await openGate(page);
  const dialog = confirm(page);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'This draft changed in another tab. Show the latest to keep editing.',
  );
  // Publish can't be pressed now, so nothing offers to try again, and focus isn't lost with it.
  await expect(
    dialog.getByRole('button', { name: 'Publish', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Show the latest' }),
  ).toBeFocused();
  await expect(dialog).not.toContainText(/try again/i);
  await dialog.getByRole('button', { name: 'Show the latest' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('This draft changed in another tab')).toHaveCount(
    0,
  );
  await expect(publishButton(page)).toBeFocused();
  await expect(publishButton(page)).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('when the latest can’t be loaded, the editor says so and keeps the banner', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  await answerPublish(page, (route) =>
    route.fulfill(refusal(409, 'STUDIO_DRAFT_STALE')),
  );
  await openEditor(page);
  await openGate(page);
  const dialog = confirm(page);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.route(
    `${API_ORIGIN}/v1/me/studio`,
    (route) => route.abort('internetdisconnected'),
    // A read isn't retried after a network failure, so one is enough.
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Show the latest' }).click();
  const banner = page.locator('div.pst-banner');
  await expect(banner.getByRole('alert')).toHaveText(
    'We couldn’t load the latest. Check your connection, then try again.',
  );
  await expect(banner).toContainText('This draft changed in another tab');
  await expect(dialog).toHaveCount(0);
  await expect(
    banner.getByRole('button', { name: 'Show the latest' }),
  ).toBeFocused();
  // Once it loads, the banner and the words go.
  await banner.getByRole('button', { name: 'Show the latest' }).click();
  await expect(page.locator('div.pst-banner')).toHaveCount(0);
});

test('a stale draft says this tab’s last changes weren’t saved before “Show the latest” drops them', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', blocks: FIVE_BLOCKS });
  await openEditor(page);
  await page.route(`${API_ORIGIN}/v1/me/studio/draft`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill(refusal(409, 'STUDIO_DRAFT_STALE'))
      : route.continue(),
  );
  await card(page, 'Journal').click();
  const banner = page.locator('div.pst-banner').filter({
    hasText: 'This draft changed in another tab',
  });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(
    'Your last changes in this tab weren’t saved.',
  );
  await page.unroute(`${API_ORIGIN}/v1/me/studio/draft`);
  await banner.getByRole('button', { name: 'Show the latest' }).click();
  await expect(page.locator('div.pst-banner')).toHaveCount(0);
  await expect(card(page, 'Clear')).toHaveAttribute('aria-checked', 'true');
});

test('read-only after a refused save, pressing Publish moves focus to the banner', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  await page.route(`${API_ORIGIN}/v1/me/studio/draft`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill(refusal(403, 'STUDIO_PRO_REQUIRED'))
      : route.continue(),
  );
  await card(page, 'Journal').click();
  const banner = page.locator('.pst-banner').filter({
    hasText: 'That change needs Pro',
  });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(publishButton(page)).toHaveAttribute('aria-disabled', 'true');
  await openGate(page);
  await expect(banner).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const width of [320, 390, 1440])
  test(`axe is clean on both publish dialogs at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width,
      height: width === 320 ? 640 : width === 390 ? 844 : 900,
    });
    await signUpRecipient(page, testInfo, { live: false });
    await saveDraft(page, {
      style: 'clear',
      blocks: [...FIVE_BLOCKS.slice(0, 2), EMPTY_QUOTES[0]],
    });
    await openEditor(page);
    await openGate(page);
    await expect(blocked(page)).toBeVisible();
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
    await blocked(page)
      .getByRole('button', { name: 'Remove the block' })
      .click();
    await expect(confirm(page)).toBeVisible();
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
  });
