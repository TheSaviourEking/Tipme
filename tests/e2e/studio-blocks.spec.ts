import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio editor on v2 (styles plan Task 12, PR 4a; spec §10, "The Blocks tab"): one ordered
// list. TipMe's own parts are locked rows; blocks move by drag, buttons and arrow keys, and the
// live region says where they went in G2's words; "Add a block" has no Links and marks the Pro
// kinds for Free; each kind has a form that writes only what a v2 page can show. No request ever
// reaches a real video site.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

// Sign-up, saves and photo uploads take a while on a busy machine; the steps wait on end states.
test.describe.configure({ timeout: 90_000 });

async function makePro(handle: string) {
  await sql(
    `UPDATE profiles SET staff_pro = true, plan = 'pro' WHERE handle_lower = $1`,
    [handle],
  );
}

/** The saved draft, as the API holds it. */
async function savedDraft(page: Page) {
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  return (await mine.json()).data;
}

async function saveBlocks(page: Page, blocks: unknown[]) {
  const mine = await savedDraft(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: mine.rev, draft: { ...mine.draft, style: 'clear', blocks } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Every request to a video site (there must be none). */
function videoSiteRequests(page: Page) {
  const hits: string[] = [];
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (/youtube|ytimg|tiktok|audiomack/.test(host)) hits.push(request.url());
  });
  return hits;
}

async function openBlocks(page: Page) {
  await page.goto('/dashboard/studio');
  await page.getByRole('tab', { name: 'Blocks' }).click();
  await expect(page.getByRole('heading', { name: 'Blocks' })).toBeVisible();
}

const list = (page: Page) => page.getByRole('list', { name: 'Your blocks' });
const item = (page: Page, n: number) =>
  list(page)
    .locator('li.pst-block')
    .nth(n - 1);
const handle = (page: Page, n: number) =>
  item(page, n).locator('[data-block-handle]');
/** A kind in the open "Add a block" list. */
const kind = (scope: Locator | Page, name: string) =>
  scope
    .locator('.pst-kinds')
    .getByRole('button', { name: new RegExp(`^${name}`) });
const live = (page: Page) => page.locator('.pst-blocks [role="status"]');
const order = async (page: Page) =>
  (await savedDraft(page)).draft.blocks
    .map((b: { id: string }) => b.id)
    .join(',');
/** The preview's page (a new page is Classic, which renders today's markup: no `.studio`). */
const previewPage = (page: Page) =>
  page.frameLocator('iframe[title="Preview of your page"]').locator('body');

const text = (id: string, words: string) => ({
  id,
  kind: 'text',
  variant: 'paragraph',
  text: words,
});

/** A JPEG of `size` px a side, made in the browser, for the file chooser. */
async function photoFile(page: Page, size: number) {
  const base64 = await page.evaluate(async (size) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#c84628';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#f5c400';
    g.fillRect(size / 4, size / 4, size / 2, size / 2);
    const blob = await new Promise<Blob>((done) =>
      canvas.toBlob((b) => done(b!), 'image/jpeg', 0.9),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, size);
  return {
    name: 'studio.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(base64, 'base64'),
  };
}

test('blocks reorder by drag, buttons and arrow keys', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveBlocks(page, [
    text('e2eone01', 'First'),
    text('e2etwo02', 'Second'),
    text('e2ethr03', 'Third'),
  ]);
  await openBlocks(page);
  // TipMe's parts come first, locked (this new page has no links, so no "Your links" row).
  const locked = page.getByRole('list', { name: 'Always on your page' });
  await expect(locked.getByRole('listitem')).toHaveCount(2);
  await expect(locked).toContainText('Cover, name and bio');
  await expect(locked).toContainText('Tip');
  await expect(locked).toContainText(
    'Always TipMe. Can’t be moved or removed.',
  );
  await expect(locked.getByRole('button')).toHaveCount(0);

  // Drag: the third to the top.
  await item(page, 3).locator('[data-block-grip]').dragTo(item(page, 1));
  await expect(live(page)).toHaveText('Text, moved to place 1 of 3');
  await expect.poll(() => order(page)).toBe('e2ethr03,e2eone01,e2etwo02');

  // Buttons: the new first one down.
  await item(page, 1).getByRole('button', { name: 'Move Text down' }).click();
  await expect(live(page)).toHaveText('Text, moved to place 2 of 3');
  await expect(handle(page, 2)).toBeFocused();
  await expect.poll(() => order(page)).toBe('e2eone01,e2ethr03,e2etwo02');

  // Keys on the focused block: Down, then Home; focus stays on the block that moved.
  await page.keyboard.press('ArrowDown');
  await expect(live(page)).toHaveText('Text, moved to place 3 of 3');
  await expect(handle(page, 3)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(live(page)).toHaveText('Text, moved to place 1 of 3');
  await expect(handle(page, 1)).toContainText('Third');
  await expect(handle(page, 1)).toBeFocused();
  await expect.poll(() => order(page)).toBe('e2ethr03,e2eone01,e2etwo02');
  // The preview follows the order.
  await expect(previewPage(page).locator('.studio .studio-grid')).toContainText(
    /Third[\s\S]*First[\s\S]*Second/,
  );

  // Removing a block with words asks first.
  await item(page, 1).getByRole('button', { name: 'Remove Text' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this text block?' });
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(live(page)).toHaveText('Text removed');
  await expect.poll(() => order(page)).toBe('e2eone01,e2etwo02');
});

test('"Add a block" never offers Links and marks Pro kinds PRO on Free, who can’t add them', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openBlocks(page);
  await page.getByRole('button', { name: 'Add a block' }).click();
  const kinds = page.locator('.pst-kinds');
  await expect(kinds.getByRole('button')).toHaveText([
    'Text',
    'PhotoPRO',
    'GalleryPRO',
    'VideoPRO',
    'ServicesPRO',
    'EventsPRO',
    'Quote',
  ]);
  await expect(kinds.getByRole('button', { name: /Links|About/ })).toHaveCount(
    0,
  );
  await kind(page, 'Photo').click();
  await expect(page.getByText('Photo blocks come with Pro.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'See Pro' })).toHaveAttribute(
    'href',
    '/pro',
  );
  await page.getByRole('button', { name: 'Back to the list' }).click();
  await kind(page, 'Quote').click();
  await page.getByRole('textbox', { name: 'Quote' }).fill('Sang like home.');
  await expect
    .poll(async () =>
      (await savedDraft(page)).draft.blocks.map(
        (b: { kind: string; text?: string }) => `${b.kind}:${b.text}`,
      ),
    )
    .toEqual(['quote:Sang like home.']);
});

test('each block kind has a form that writes only what a v2 page can show', async ({
  page,
}, testInfo) => {
  const hits = videoSiteRequests(page);
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await openBlocks(page);
  const add = async (name: string) => {
    await page.getByRole('button', { name: 'Add a block' }).click();
    await kind(page, name).click();
  };
  const open = () => page.locator('.pst-block[data-open]');

  // Text: a heading, with its counter and limit; no heading levels or variants.
  await add('Text');
  await open().getByRole('radio', { name: 'Heading', exact: true }).click();
  const heading = open().getByLabel('Heading', { exact: true });
  await expect(heading).toHaveAttribute('maxlength', '80');
  await heading.fill('New single out in December');
  await expect(open().getByText('26 of 80')).toBeVisible();
  await expect(
    previewPage(page).getByRole('heading', {
      name: 'New single out in December',
    }),
  ).toBeVisible();

  // Events: written once complete; what's missing is said.
  await add('Events');
  await open().getByLabel('What it is').fill('Live set, Lekki');
  await open().getByRole('button', { name: 'Add the event' }).click();
  await expect(open().getByText('Add the date.')).toBeVisible();
  await open().getByLabel('Date').fill('2099-11-15');
  await open().getByRole('button', { name: 'Add the event' }).click();
  await expect(previewPage(page)).toContainText('Live set, Lekki');

  // Video: other sites are refused in plain words; a YouTube link shows TipMe's still only.
  await add('Video');
  const link = page.locator('.pst-add__panel').getByLabel('Video link');
  await link.fill('https://www.instagram.com/p/abc123/');
  await page.getByRole('button', { name: 'Add the video' }).click();
  await expect(
    page.getByText('We can’t show videos from that site yet.', {
      exact: false,
    }),
  ).toBeVisible();
  await link.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.getByRole('button', { name: 'Add the video' }).click();
  await expect(open().locator('[data-block-handle]')).toContainText('Video');

  // Quote; a gallery starts with the shared photo picker.
  await add('Quote');
  await open()
    .getByRole('textbox', { name: 'Quote' })
    .fill('Every tip is a song.');
  await expect(previewPage(page)).toContainText('Every tip is a song.');
  await add('Gallery');
  await expect(
    open().getByRole('button', { name: 'Choose a photo' }),
  ).toBeVisible();

  await expect
    .poll(async () =>
      (await savedDraft(page)).draft.blocks.map(
        (b: Record<string, unknown>) =>
          `${b.kind}${'variant' in b ? `:${b.variant}` : ''}`,
      ),
    )
    .toEqual(['text:heading', 'events', 'video', 'quote', 'gallery']);
  // No columns, spacing, background or variant choices anywhere.
  for (const word of ['Columns', 'Spacing', 'Background', 'Band', 'Grid'])
    await expect(
      page.getByRole('tabpanel').getByRole('radio', { name: word }),
    ).toHaveCount(0);
  expect(hits).toEqual([]);
});

test('a photo uploaded into a block appears in the preview; “Add a description” opens its field', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await openBlocks(page);
  await page.getByRole('button', { name: 'Add a block' }).click();
  await kind(page, 'Photo').click();
  await page
    .locator('.pst-add__panel input[type=file]')
    .setInputFiles(await photoFile(page, 1600));
  // The upload is re-encoded on the server first.
  await expect(handle(page, 1)).toContainText('Photo', { timeout: 30_000 });
  const shown = previewPage(page).locator('.classic-blocks img');
  await expect(shown).toHaveCount(1);

  // The check asks for a description; its button opens the form at that field.
  await page.getByRole('tab', { name: /^Check/ }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('A photo has no description')).toBeVisible();
  await panel.getByRole('button', { name: 'Add a description' }).click();
  await expect(page.getByRole('tab', { name: 'Blocks' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const alt = page.getByLabel('Description', { exact: true });
  await expect(alt).toBeFocused();
  await alt.fill('Kemi on stage at Studio night, Yaba');
  await expect(shown).toHaveAttribute(
    'alt',
    'Kemi on stage at Studio night, Yaba',
  );
  await expect(page.getByRole('tab', { name: /^Check/ })).toContainText('Pass');
});
