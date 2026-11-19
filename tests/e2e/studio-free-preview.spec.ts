import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio, Free previews of Pro styles and the lapse banner (styles plan Task 16, PR 5c; spec
// §12.4–12.5). On Free every Pro card can be chosen: the preview shows the real style under a PRO
// tag, nothing is saved ("Previewing a Pro style: not saved"), and choosing a free style saves
// again. A preview is not an undo step; the free style that ends it is one. When Pro lapses, the
// editor opens as usual with a banner naming what visitors see. The `page_studio` switch is on in
// the e2e stack.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

// Sign-up and saves take a while on a busy machine; the steps wait on end states.
test.describe.configure({ timeout: 90_000 });

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

async function publishNow(page: Page) {
  const mine = await savedStudio(page);
  const published = await page.request.post(
    `${API_ORIGIN}/v1/me/studio/publish`,
    { headers, data: { rev: mine.rev } },
  );
  expect(published.status(), await published.text()).toBe(200);
}

/** Counts the editor's own draft saves (`PUT /v1/me/studio/draft`) and publishes from here on. */
function countRequests(page: Page) {
  const seen = { saves: 0, publishes: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (request.method() === 'PUT' && url.endsWith('/v1/me/studio/draft'))
      seen.saves += 1;
    if (request.method() === 'POST' && url.endsWith('/v1/me/studio/publish'))
      seen.publishes += 1;
  });
  return seen;
}

const PREVIEWING = 'Previewing a Pro style: not saved';
const bar = (page: Page) => page.locator('.pst-bar');
const status = (page: Page) => bar(page).getByRole('status');
const undoButton = (page: Page) =>
  bar(page).getByRole('button', { name: /^Undo/ });
const publishButton = (page: Page) =>
  bar(page).getByRole('button', { name: /^Publish/ });
const cards = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Style', exact: true });
const card = (page: Page, name: string) =>
  cards(page).getByRole('radio', { name: new RegExp(`^${name},`) });
const swatch = (page: Page, name: string) =>
  page
    .getByRole('radiogroup', { name: /^Accent/ })
    .getByRole('radio', { name, exact: true });
const choice = (page: Page, group: string, name: string) =>
  page
    .getByRole('radiogroup', { name: group, exact: true })
    .getByRole('radio', { name, exact: true });
/** The PRO tag above the preview: a polite live region, so its words are announced. */
const proTag = (page: Page) => page.locator('.pst-preview-pro');
const lapse = (page: Page) => page.locator('.pst-lapse');
const previewPage = (page: Page) =>
  page.frameLocator('iframe[title="Preview of your page"]').locator('.studio');

async function openEditor(page: Page) {
  await page.goto('/dashboard/studio');
  await expect(
    page.getByRole('heading', { name: 'Page Studio', level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(cards(page)).toBeVisible();
}

/** Longer than the 800 ms save pause, twice over: a save that was going to be sent has been. */
const pastTheSavePause = (page: Page) => page.waitForTimeout(2_000);

test('a Free person previews Stage: the preview shows it with a PRO tag, the status reads "Previewing a Pro style: not saved", and no save request is sent', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  const seen = countRequests(page);
  // Every Pro card is a real, selectable radio; Free still sees them marked PRO.
  for (const name of ['Stage', 'Signboard', 'Sprint', 'Tiles', 'Horizon'])
    await expect(card(page, name)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(cards(page).getByText('PRO', { exact: true })).toHaveCount(5);
  await expect(proTag(page)).toHaveAttribute('role', 'status');
  await expect(proTag(page)).toHaveText('');

  await card(page, 'Stage').click();
  await expect(card(page, 'Stage')).toHaveAttribute('aria-checked', 'true');
  await expect(previewPage(page)).toHaveAttribute('data-style', 'stage');
  await expect(proTag(page)).toBeVisible();
  await expect(proTag(page)).toContainText('PRO');
  await expect(proTag(page)).toContainText('Stage comes with Pro.');
  await expect(status(page)).toHaveText(PREVIEWING);
  // Edits while previewing aren't saved either.
  await choice(page, 'Appearance', 'Dark').click();
  await expect(previewPage(page)).toHaveAttribute('data-mode', 'dark');
  await pastTheSavePause(page);
  expect(seen.saves).toBe(0);
  await expect(status(page)).toHaveText(PREVIEWING);
  const stored = (await savedStudio(page)).draft;
  expect([stored.style, stored.mode]).toEqual(['classic', 'light']);
});

test('choosing a free style resumes saving', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  const seen = countRequests(page);
  await card(page, 'Horizon').click();
  await expect(status(page)).toHaveText(PREVIEWING);
  // A preview isn't an undo step: Undo ends it, back to the draft as it was, with nothing to save.
  await expect(undoButton(page)).toHaveAccessibleName(
    'Undo: style changed to Horizon',
  );
  await undoButton(page).click();
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await expect(status(page)).toHaveText('Saved · not published');
  await expect(proTag(page)).toHaveText('');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');

  // Stage, then Signboard (both previews), then Journal: one step, and Journal is saved.
  await card(page, 'Stage').click();
  await card(page, 'Signboard').click();
  await expect(status(page)).toHaveText(PREVIEWING);
  await card(page, 'Journal').click();
  await expect(previewPage(page)).toHaveAttribute('data-style', 'journal');
  await expect(proTag(page)).toHaveText('');
  await expect
    .poll(async () => (await savedStudio(page)).draft.style, {
      timeout: 10_000,
    })
    .toBe('journal');
  await expect(status(page)).toHaveText('Saved · not published');
  expect(seen.saves).toBeGreaterThan(0);
  await expect(undoButton(page)).toHaveAccessibleName(
    'Undo: style changed to Journal',
  );
  // Undo goes back past the previews to Classic, and saves it.
  await undoButton(page).click();
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(async () => (await savedStudio(page)).draft.style, {
      timeout: 10_000,
    })
    .toBe('classic');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
});

test('publishing while previewing shows the pro-only issue', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  const seen = countRequests(page);
  await card(page, 'Stage').click();
  await expect(publishButton(page)).toHaveText('Publish · 1 to fix');
  // aria-disabled but focusable (§12.1): a keyboard press opens the list.
  await publishButton(page).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Your page can’t be published yet',
  });
  await expect(dialog.getByText('Stage is a Pro style')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'See Pro' })).toHaveAttribute(
    'href',
    '/pro',
  );
  await dialog.getByRole('button', { name: 'Choose a free style' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, 'Stage')).toBeFocused();
  // Nothing was saved or published on the way.
  await expect(status(page)).toHaveText(PREVIEWING);
  expect(seen).toEqual({ saves: 0, publishes: 0 });
});

test('the photo swatch stays disabled on Free', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  await card(page, 'Stage').click();
  await expect(status(page)).toHaveText(PREVIEWING);
  const photo = swatch(page, 'From your photo');
  await expect(photo).toHaveAttribute('aria-disabled', 'true');
  await photo.dispatchEvent('click');
  await expect(photo).not.toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByText('“From your photo” comes with Pro.'),
  ).toBeVisible();
});

test('a lapsed person sees the banner with "See Pro" and can edit within the Free rules', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await saveDraft(page, { style: 'stage', accent: 'coral' });
  await publishNow(page);
  await setPlan(who.handle, 'free');
  await openEditor(page);

  await expect(lapse(page)).toContainText(
    'Your Pro has ended. Your page shows Classic until Pro is back. Your design is kept.',
  );
  await expect(
    lapse(page).getByRole('link', { name: 'See Pro' }),
  ).toHaveAttribute('href', '/pro');
  // The draft keeps Stage, under the PRO tag; it isn't a preview, so edits save.
  await expect(card(page, 'Stage')).toHaveAttribute('aria-checked', 'true');
  await expect(proTag(page)).toContainText('Stage comes with Pro.');
  await choice(page, 'Appearance', 'Dark').click();
  await expect
    .poll(
      async () => {
        const draft = (await savedStudio(page)).draft;
        return [draft.style, draft.mode];
      },
      { timeout: 10_000 },
    )
    .toEqual(['stage', 'dark']);
  await expect(status(page)).toHaveText('Saved · not published');
  // Another Pro style is a preview, as for any Free page.
  await card(page, 'Tiles').click();
  await expect(status(page)).toHaveText(PREVIEWING);
});

for (const width of [320, 390, 1440])
  test(`previewing a Pro style and the lapse banner fit and are accessible at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const who = await signUpRecipient(page, testInfo, { live: false });
    await setPlan(who.handle, 'pro');
    await saveDraft(page, { style: 'tiles' });
    await publishNow(page);
    await saveDraft(page, { style: 'clear' });
    await setPlan(who.handle, 'free');
    await openEditor(page);
    await expect(lapse(page)).toBeVisible();
    await card(page, 'Stage').click();
    await expect(status(page)).toHaveText(PREVIEWING);
    await expect(proTag(page)).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(await fitsViewport(page)).toBe(true);
    await expectAccessible(page);
  });
