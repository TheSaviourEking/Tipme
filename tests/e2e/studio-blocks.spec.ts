import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio editor, PR G2 (plan 2026-11-12-page-studio, Task 9b): the Blocks tab. Rows and
// blocks move by mouse (Up/Down, drag) and by keyboard; every block kind has a form; limits say
// why; the design check's fixes that need the person's input open the block's form. No request
// ever reaches a real video site: the preview shows TipMe's still, and nothing is tapped.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

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

async function saveRows(page: Page, rows: unknown[]) {
  const mine = await savedDraft(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: mine.rev, draft: { ...mine.draft, rows } },
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
  await expect(
    page.getByRole('heading', { name: 'Rows and blocks' }),
  ).toBeVisible();
}

const rowsList = (page: Page) => page.getByRole('list', { name: 'Your rows' });
const rowItem = (page: Page, n: number) =>
  rowsList(page)
    .locator('li.pst-row')
    .nth(n - 1);
const rowHandle = (page: Page, n: number) =>
  rowItem(page, n).locator('[data-row-handle]');
/** A kind in an open "Add a block" list. */
const kind = (scope: Locator, name: string) =>
  scope.locator('.pst-kinds').getByRole('button', { name, exact: true });
const live = (page: Page) => page.locator('.pst-blocks [role="status"]');
const order = async (page: Page) =>
  (await savedDraft(page)).draft.rows
    .map((r: { id: string }) => r.id)
    .join(',');

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

const text = (id: string, words = 'Words') => ({
  id,
  kind: 'text',
  variant: 'paragraph',
  text: words,
});
const oneRow = (id: string, blocks: unknown[], columns = '1') => ({
  id,
  columns,
  spacing: 'm',
  background: 'page',
  cells: [blocks],
});

test('G2: a Pro person adds a 2-1 row, adds Services, moves it first by keyboard', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveRows(page, [oneRow('rowfirst', [text('blkfirst', 'Hello')])]);
  await openBlocks(page);
  // TipMe's parts are locked lines: no buttons, nothing to drag.
  await expect(
    page.getByText('Always TipMe. Can’t be moved, styled or removed.').first(),
  ).toBeVisible();
  await expect(
    page.locator('.pst-row--locked button, .pst-row--locked [draggable]'),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Add a row' }).click();
  await expect(live(page)).toHaveText('Row 2 added');
  await expect(rowHandle(page, 2)).toBeFocused();
  const row = rowItem(page, 2);
  await row.getByRole('button', { name: '2 : 1', exact: true }).click();
  await expect(
    row.getByRole('button', { name: '2 : 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    row.getByRole('region', { name: 'Row 2, column 2' }),
  ).toBeVisible();

  const first = row.getByRole('region', { name: 'Row 2, column 1' });
  await first.getByRole('button', { name: 'Add a block' }).click();
  await kind(first, 'Services').click();
  await first.getByLabel('Name').fill('Haircut and line-up');
  await first.getByLabel('Price in naira').fill('5,000');
  await first.getByRole('button', { name: 'Add the service' }).click();
  await expect(first.getByRole('group', { name: 'Service 1' })).toBeVisible();
  const preview = page.locator('.pst-preview .studio');
  await expect(preview).toContainText('Haircut and line-up');
  await expect(preview).toContainText(
    'Prices are for information. Tips here are a gift, not a payment for a service.',
  );

  // Moved first with the keyboard: an arrow key on the focused row.
  await rowHandle(page, 2).focus();
  await page.keyboard.press('ArrowUp');
  await expect(live(page)).toContainText('moved to position 1 of');
  await expect(live(page)).toHaveText('Row 2, moved to position 1 of 2');
  await expect(rowHandle(page, 1)).toBeFocused();
  await expect
    .poll(async () => {
      const d = (await savedDraft(page)).draft;
      const b = d.rows[0].cells[0][0];
      return [d.rows[0].columns, b?.kind, b?.items?.[0]?.priceMinor].join(' ');
    })
    .toBe('2-1 services 500000');
});

test('G2: rows move by Up, Down and drag; blocks by buttons and arrow keys; removing asks first', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveRows(page, [
    oneRow('raaaaaaa', [text('baaaaaaa', 'First')]),
    oneRow('rbbbbbbb', [text('bbbbbbbb', 'Second')]),
    oneRow('rccccccc', [text('bccccccc', 'Third')]),
  ]);
  await openBlocks(page);

  await page.getByRole('button', { name: 'Move row 3 up' }).click();
  await expect(live(page)).toHaveText('Row 3, moved to position 2 of 3');
  await expect.poll(() => order(page)).toBe('raaaaaaa,rccccccc,rbbbbbbb');
  await page.getByRole('button', { name: 'Move row 1 down' }).click();
  await expect.poll(() => order(page)).toBe('rccccccc,raaaaaaa,rbbbbbbb');

  // Drag, with the mouse: the last row onto the first (row 2, open since the start, closed first).
  await rowHandle(page, 2).click();
  await expect(rowsList(page).locator('li.pst-row[data-open]')).toHaveCount(0);
  await rowItem(page, 3).locator('[data-row-grip]').dragTo(rowItem(page, 1));
  await expect(live(page)).toHaveText('Row 3, moved to position 1 of 3');
  await expect.poll(() => order(page)).toBe('rbbbbbbb,rccccccc,raaaaaaa');

  // Blocks: a quote after the text, then moved up by keyboard and down by button.
  await rowHandle(page, 1).click();
  const row = rowItem(page, 1);
  await expect(row).toHaveAttribute('data-open', 'true');
  await row.getByRole('button', { name: 'Add a block' }).click();
  await kind(row, 'Quote').click();
  await row
    .getByRole('textbox', { name: 'Quote' })
    .fill('Music is how I say thank you.');
  await row
    .locator('li.pst-block')
    .nth(1)
    .locator('[data-block-handle]')
    .focus();
  await page.keyboard.press('ArrowUp');
  await expect(live(page)).toHaveText('Quote, moved to place 1 of 2');
  await expect(
    row.locator('li.pst-block').nth(0).locator('[data-block-handle]'),
  ).toBeFocused();
  await expect
    .poll(async () =>
      (await savedDraft(page)).draft.rows[0].cells[0]
        .map((b: { kind: string }) => b.kind)
        .join(','),
    )
    .toBe('quote,text');
  await row.getByRole('button', { name: 'Move Quote down' }).click();
  await expect(live(page)).toHaveText('Quote, moved to place 2 of 2');

  // Removing a block with words asks first; Cancel keeps it.
  await row.getByRole('button', { name: 'Remove Quote' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this quote block?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Remove Quote' })).toBeVisible();
  await row.getByRole('button', { name: 'Remove Quote' }).click();
  await page
    .getByRole('dialog', { name: 'Remove this quote block?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(row.getByRole('button', { name: 'Remove Quote' })).toHaveCount(
    0,
  );
  // And a whole row.
  await row.getByRole('button', { name: 'Remove row 1' }).click();
  await page
    .getByRole('dialog', { name: 'Remove row 1?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect.poll(() => order(page)).toBe('rccccccc,raaaaaaa');
});

test('G2: each block kind has a form that writes only what the page can show', async ({
  page,
}, testInfo) => {
  const hits = videoSiteRequests(page);
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveRows(page, []);
  await openBlocks(page);
  await page.getByRole('button', { name: 'Add a row' }).click();
  const row = rowItem(page, 1);
  await row.getByRole('button', { name: '1 : 1 : 1', exact: true }).click();
  const col = (c: number) =>
    row.getByRole('region', { name: `Row 1, column ${c}` });
  const preview = page.locator('.pst-preview .studio');

  // Text: a heading, with its counter and maxLength.
  await col(1).getByRole('button', { name: 'Add a block' }).click();
  await kind(col(1), 'Text').click();
  await col(1).getByRole('button', { name: 'Heading', exact: true }).click();
  const heading = col(1).getByLabel('Heading', { exact: true });
  await expect(heading).toHaveAttribute('maxlength', '80');
  await heading.fill('New single out in December');
  await expect(col(1).getByText('26 of 80')).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: 'New single out in December' }),
  ).toBeVisible();

  // Events: written once complete; what's missing is said.
  await col(1).getByRole('button', { name: 'Add a block' }).click();
  await kind(col(1), 'Events').click();
  await col(1).getByLabel('What it is').fill('Live set, Lekki');
  await col(1).getByRole('button', { name: 'Add the event' }).click();
  await expect(col(1).getByText('Add the date.')).toBeVisible();
  await col(1).getByLabel('Date').fill('2099-11-15');
  await col(1).getByLabel('Time (optional)').fill('20:00');
  await col(1).getByRole('button', { name: 'Add the event' }).click();
  await expect(preview).toContainText('Live set, Lekki');

  // Video: other sites are refused in plain words; a YouTube link shows TipMe's still only.
  await col(2).getByRole('button', { name: 'Add a block' }).click();
  await kind(col(2), 'Video').click();
  const link = col(2).getByLabel('Video link');
  await link.fill('https://www.instagram.com/p/abc123/');
  await col(2).getByRole('button', { name: 'Add the video' }).click();
  await expect(
    col(2).getByText('We can’t show videos from that site yet.', {
      exact: false,
    }),
  ).toBeVisible();
  await link.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await col(2).getByRole('button', { name: 'Add the video' }).click();
  await expect(col(2).locator('[data-block-handle]')).toContainText('Video');
  await expect(preview).toContainText('YouTube');

  // Quote has a band style; a gallery starts with the shared photo picker.
  await col(3).getByRole('button', { name: 'Add a block' }).click();
  await kind(col(3), 'Quote').click();
  await col(3).getByRole('button', { name: 'Band', exact: true }).click();
  await col(3)
    .getByRole('textbox', { name: 'Quote' })
    .fill('Every tip is a song.');
  await expect(preview).toContainText('Every tip is a song.');
  await col(3).getByRole('button', { name: 'Add a block' }).click();
  await kind(col(3), 'Gallery').click();
  await expect(
    col(3).getByRole('button', { name: 'Choose a photo' }),
  ).toBeVisible();
  // Links shows My page's links; this new person has none, so it says why and adds nothing.
  await col(3).getByRole('button', { name: 'Add a block' }).click();
  const links = kind(col(3), 'Links');
  await expect(links).toHaveAttribute('aria-disabled', 'true');
  await expect(
    col(3).getByText('Add your links in My page first. This block shows them.'),
  ).toBeVisible();
  await links.dispatchEvent('click');

  await expect
    .poll(async () =>
      ((await savedDraft(page)).draft.rows[0]?.cells ?? [])
        .map((c: { kind: string; variant: string }[]) =>
          c.map((b) => `${b.kind}:${b.variant}`).join('+'),
        )
        .join(' | '),
    )
    .toBe('text:heading+events:list | video:still | quote:band+gallery:grid');
  expect(hits).toEqual([]);
});

test('G2: limits say why: 12 rows, a full column, and columns that can’t hold the blocks', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  const rows = Array.from({ length: 12 }, (_, r) =>
    r === 0
      ? {
          id: 'row00000',
          columns: '1-1',
          spacing: 'm',
          background: 'page',
          cells: [
            [text('blk00a01'), text('blk00a02'), text('blk00a03')],
            [text('blk00b01'), text('blk00b02')],
          ],
        }
      : oneRow(`row000${String(r).padStart(2, '0')}`, []),
  );
  await saveRows(page, rows);
  await openBlocks(page);
  await expect(
    page.getByText('Your page has 12 rows, the most it can have.'),
  ).toBeVisible();
  const add = page.getByRole('button', { name: 'Add a row' });
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled (it stays focusable, so its reason is read): a press changes nothing.
  await add.dispatchEvent('click');
  expect((await savedDraft(page)).draft.rows).toHaveLength(12);

  const row = rowItem(page, 1);
  await expect(
    row
      .getByRole('region', { name: 'Row 1, column 1' })
      .getByText('This column has 3 blocks, the most one column can hold.'),
  ).toBeVisible();
  await row.getByRole('button', { name: 'One column', exact: true }).click();
  await expect(row.getByRole('alert')).toHaveText(
    'This row has 5 blocks, and one column holds 3. Remove 2 blocks or move them to another row first.',
  );
  expect((await savedDraft(page)).draft.rows[0].columns).toBe('1-1');
  // Moving into a full column is offered disabled, not refused afterwards.
  await expect(
    row
      .getByRole('region', { name: 'Row 1, column 2' })
      .getByRole('button', { name: 'Move Text to the column on the left' })
      .first(),
  ).toBeDisabled();
});

test('G2: a photo uploaded into a block appears in the preview; “Add a description” opens its field', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveRows(page, []);
  await openBlocks(page);
  await page.getByRole('button', { name: 'Add a row' }).click();
  const row = rowItem(page, 1);
  await row.getByRole('button', { name: 'Add a block' }).click();
  await kind(row, 'Photo').click();
  // The shared picker, without its crop step: Studio keeps the whole photo.
  await row
    .locator('.pst-add__panel input[type=file]')
    .setInputFiles(await photoFile(page, 1600));
  await expect(row.locator('[data-block-handle]')).toContainText('Photo');
  await expect(page.locator('input[type=range]')).toHaveCount(0);
  const shown = page.locator('.pst-preview .studio-rows img');
  await expect(shown).toHaveCount(1);
  await expect
    .poll(() =>
      shown.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth,
      ),
    )
    .toBeGreaterThan(0);

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
  await expect(
    page.getByRole('tab', { name: 'Check', exact: true }),
  ).toBeVisible();

  // A too-small photo is refused in plain words.
  await page
    .locator('.pst-block [data-field="photo"] input[type=file]')
    .setInputFiles(await photoFile(page, 300));
  await expect(
    page.getByText('This photo is too small.', { exact: false }),
  ).toBeVisible();
});

test('G2: “Edit the text” opens the words with the long word', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await saveRows(page, [
    {
      id: 'rowlong1',
      columns: '1-1-1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'blklong1',
            kind: 'quote',
            variant: 'plain',
            text: 'Supercalifragilisticexpialidocious-and-then-some-more',
          },
        ],
        [],
        [],
      ],
    },
  ]);
  await page.goto('/dashboard/studio');
  const check = page.getByRole('complementary', { name: 'Design check' });
  await expect(check.getByText('A long word won’t fit')).toBeVisible();
  await check.getByRole('button', { name: 'Edit the text' }).click();
  const words = page.getByLabel('Quote', { exact: true });
  await expect(words).toBeFocused();
  await words.fill('Short words fit.');
  await expect(check.getByText('A long word won’t fit')).toHaveCount(0);
});

test('G2: no control takes a font size, a position or CSS; Show grid; axe on Blocks @mobile', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await openBlocks(page);
  await page.getByRole('button', { name: 'Add a row' }).click();
  const row = rowsList(page).locator('li.pst-row').last();
  await row.getByRole('button', { name: 'Add a block' }).click();
  await expect(kind(row, 'Services')).toBeVisible();
  expect(
    await page
      .locator('input[type=range], [contenteditable], textarea[name*=css]')
      .count(),
  ).toBe(0);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
  await kind(row, 'Text').click();
  await expectAccessible(page);
  const grid = page.getByLabel('Show grid');
  await grid.check();
  await expect(page.locator('.pst-preview__page')).toHaveAttribute(
    'data-grid',
    'true',
  );
  await grid.uncheck();
  await expect(page.locator('.pst-preview__page')).not.toHaveAttribute(
    'data-grid',
    /.*/,
  );
});
