import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';

// Social links (SocialLinks board, owner 5 Nov 2026). Free: 3 links from Free sites. Pro: 8, own
// order (arrows or drag), one featured. When Pro ends the page shows 3 and keeps the rest.

const section = (page: Page) =>
  page.locator('.settings-section', {
    has: page.getByRole('heading', { name: 'Your links' }),
  });

const paste = async (page: Page, url: string) => {
  await section(page).getByLabel('Add a link').fill(url);
  await section(page).getByRole('button', { name: 'Add', exact: true }).click();
};

async function saveLinks(page: Page) {
  await section(page).getByRole('button', { name: 'Save links' }).click();
  await expect(section(page).getByRole('status')).toHaveText('Saved');
}

/** The page is rebuilt after a save; reload until it shows what was saved. */
async function visit(
  visitor: Page,
  handle: string,
  check: () => Promise<void>,
) {
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await check();
  }).toPass({ timeout: 15_000 });
}

const rowNames = (visitor: Page) =>
  visitor
    .getByRole('list', { name: /elsewhere$/ })
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.textContent ?? ''));

test('Free: three links from Free sites, each mistake explained on its own row', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const links = section(page);

  await links.getByRole('button', { name: '+ TikTok' }).click();
  await expect(
    links.getByRole('textbox', { name: 'TikTok link', exact: true }),
  ).toBeFocused();
  await links
    .getByRole('textbox', { name: 'TikTok link', exact: true })
    .fill('https://www.tiktok.com/@ada.edits');

  // "+ more" goes away when pressed; focus lands on the first site it revealed.
  await links.getByRole('button', { name: '+ more' }).click();
  await expect(links.getByRole('button', { name: '+ Snapchat' })).toBeFocused();

  // A Pro site and a link page are refused before they become rows.
  await paste(page, 'https://t.me/adaedits');
  await expect(
    links.getByText('Telegram links are part of TipMe Pro.'),
  ).toBeVisible();
  await expect(links.getByLabel('Add a link')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await paste(page, 'https://linktr.ee/ada');
  await expect(
    links.getByText(/Link pages and short links aren’t supported/),
  ).toBeVisible();
  await paste(page, 'https://instagram.com/ada.edits');
  await expect(
    links.getByRole('textbox', { name: 'Instagram link', exact: true }),
  ).toHaveValue('https://instagram.com/ada.edits');

  // Saving shows the error under the row and moves focus there.
  await links.getByRole('button', { name: '+ YouTube' }).click();
  await links
    .getByRole('textbox', { name: 'YouTube link', exact: true })
    .fill('https://youtube.com/');
  await links.getByRole('button', { name: 'Save links' }).click();
  await expect(
    links.getByRole('textbox', { name: 'YouTube link', exact: true }),
  ).toBeFocused();
  await expect(
    links.getByRole('textbox', { name: 'YouTube link', exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(
    links.getByText('Use a full https:// link to your YouTube page.'),
  ).toBeVisible();
  await links
    .getByRole('textbox', { name: 'YouTube link', exact: true })
    .fill('https://youtube.com/@adaedits');

  // Three is Free's limit; reordering and featuring are Pro.
  await expect(
    links.getByRole('link', { name: 'Add more links with Pro (up to 8)' }),
  ).toBeVisible();
  await expect(links.getByLabel('Add a link')).toHaveCount(0);
  await expect(links.getByRole('button', { name: /^Move the/ })).toHaveCount(0);
  await expect(links.getByRole('button', { name: /^Feature the/ })).toHaveCount(
    0,
  );
  await expect(links.getByText('3 of 3 used.', { exact: false })).toBeVisible();
  await saveLinks(page);
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await visit(visitor, handle, async () => {
    expect(await rowNames(visitor)).toEqual([
      'TTTikTok: @ada.edits (opens in a new tab)',
      'IGInstagram: @ada.edits (opens in a new tab)',
      'YTYouTube: @adaedits (opens in a new tab)',
    ]);
  });
  // Typed by the owner, so marked as user content, and opened in a new tab.
  const first = visitor
    .getByRole('list', { name: /elsewhere$/ })
    .getByRole('link')
    .first();
  await expect(first).toHaveAttribute(
    'rel',
    'noopener noreferrer nofollow ugc',
  );
  await expect(first).toHaveAttribute('target', '_blank');
  await expectAccessible(visitor);
});

test('Pro: own order by keyboard, one featured link, Pro sites; when Pro ends the page shows 3 and keeps the rest', async ({
  page,
  browser,
}, testInfo) => {
  // Sign-up, staff enrolment, a plan change and two page rebuilds.
  test.setTimeout(120_000);
  const { handle } = await signUpRecipient(page, testInfo);
  const staff = await makePagePro(browser, handle, testInfo);
  await page.reload();
  const links = section(page);

  await paste(page, 'https://www.tiktok.com/@ada.edits');
  await paste(page, 'https://instagram.com/ada.edits');
  await paste(page, 'https://twitch.tv/adaedits');
  await paste(page, 'https://adaedits.com');
  await paste(page, 'https://t.me/adaedits');
  await expect(
    links.getByRole('textbox', { name: 'Website link', exact: true }),
  ).toHaveValue('https://adaedits.com');

  // Twitch to the top with the keyboard: focus stays on the arrow and the move is announced.
  const up = links.getByRole('button', { name: 'Move the Twitch link up' });
  await up.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(up).toBeFocused();
  await expect(links.getByText('Twitch link moved to 1 of 5.')).toBeAttached();
  await links.getByRole('button', { name: 'Feature the Twitch link' }).click();
  await expect(
    links.getByRole('button', { name: 'Feature the Twitch link' }),
  ).toHaveAttribute('aria-pressed', 'true');
  // Removing a row moves focus to the next one.
  await links
    .getByRole('button', { name: 'Remove the Instagram link' })
    .click();
  await expect(
    links.getByRole('textbox', { name: 'Website link', exact: true }),
  ).toBeFocused();
  await expect(links.getByText('4 of 8.', { exact: false })).toBeVisible();
  await saveLinks(page);
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await visit(visitor, handle, async () => {
    await expect(
      visitor.getByRole('link', {
        name: 'Watch me live on Twitch @adaedits (opens in a new tab)',
      }),
    ).toBeVisible({ timeout: 1000 });
  });
  expect(await rowNames(visitor)).toEqual([
    'TTTikTok: @ada.edits (opens in a new tab)',
    'wwwWebsite: adaedits.com (opens in a new tab)',
    'TGTelegram: @adaedits (opens in a new tab)',
  ]);
  await expectAccessible(visitor);

  // Staff move the page back to Free: the website and Telegram hide, as does the featured key.
  await staff.getByRole('button', { name: 'Move back to Free…' }).click();
  await staff
    .getByLabel('Why is this page going back to Free?')
    .fill('Pro subscription ended');
  await staff
    .getByRole('button', { name: 'Move to Free', exact: true })
    .click();
  await expect(staff.getByText(`@${handle} is back on Free`)).toBeVisible();
  await visit(visitor, handle, async () => {
    expect(await rowNames(visitor)).toEqual([
      'TwTwitch: @adaedits (opens in a new tab)',
      'TTTikTok: @ada.edits (opens in a new tab)',
    ]);
  });
  await expect(
    visitor.getByRole('link', { name: /^Watch me live/ }),
  ).toHaveCount(0);

  // The editor on Free shows what shows, and lists what is kept, each with Remove.
  await page.reload();
  await expect(links.locator('.link-row')).toHaveCount(2);
  const kept = links.getByRole('list', { name: 'Kept from Pro' });
  await expect(kept.getByRole('listitem')).toHaveCount(2);
  await expect(kept.getByText('Not shown: part of Pro')).toHaveCount(2);
  await expectAccessible(page);
  // Removing one moves focus to the other's Remove, and the save deletes it.
  await kept
    .getByRole('button', { name: 'Remove the kept Telegram link' })
    .click();
  await expect(
    kept.getByRole('button', { name: 'Remove the kept Website link' }),
  ).toBeFocused();
  await saveLinks(page);
  await page.reload();
  await expect(kept.getByRole('listitem')).toHaveCount(1);
  await expect(kept).toContainText('Website: adaedits.com');
});

test('with an older API (no links yet) the editor saves Facebook, Instagram and X through the profile route', async ({
  page,
}, testInfo) => {
  // The web ships before the API: answer as an API from before social links would.
  const legacy = (data: Record<string, unknown>) => {
    const rest = { ...data };
    delete rest.links;
    delete rest.adultLinks;
    return rest;
  };

  let sent: Record<string, unknown> | null = null;
  // Every route that answers with the profile (the profile itself, going live, saving).
  await page.route('**/v1/me/**', async (route) => {
    const request = route.request();
    const isProfilePatch =
      request.method() === 'PATCH' && request.url().endsWith('/v1/me/profile');
    if (isProfilePatch && request.postData()?.includes('socials'))
      sent = JSON.parse(request.postData()!);
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!body?.data || !('socialsPublic' in body.data))
      return route.fulfill({ response });
    const data = legacy(body.data);
    // An older API stores the three links it was sent.
    if (sent && isProfilePatch) data.socials = sent.socials;
    return route.fulfill({ response, json: { data } });
  });
  await signUpRecipient(page, testInfo);
  const links = section(page);
  await expect(
    links.getByText('More sites are coming in a moment.'),
  ).toBeVisible();
  await expect(links.getByRole('button', { name: /^\+ / })).toHaveText([
    '+ Facebook',
    '+ Instagram',
    '+ X',
  ]);
  await paste(page, 'https://www.tiktok.com/@ada.edits');
  await expect(
    links.getByText(/only Facebook, Instagram and X links can be saved/),
  ).toBeVisible();
  await paste(page, 'https://instagram.com/ada.edits');
  await links.getByLabel('Show my links on my page').uncheck();
  await saveLinks(page);
  expect(sent).toEqual({
    socials: { instagram: 'https://instagram.com/ada.edits' },
    socialsPublic: false,
  });
  await expect(
    links.getByRole('textbox', { name: 'Instagram link', exact: true }),
  ).toHaveValue('https://instagram.com/ada.edits');
  await expect(links.getByLabel('Show my links on my page')).not.toBeChecked();
});
