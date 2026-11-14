import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import {
  accountOf,
  payAtBusiness,
  seedBusiness,
  seedMember,
} from './business-fixtures';
import { enrolOwner, sql } from './ops-helpers';

// TipMe for businesses, PR B5: after a paid tip made at a business, an optional kind note about
// the person (board screen 3); the person's notes on the Work page; TipMe staff review a report.
// The e2e stack runs with BUSINESS_ENABLED=true (playwright.config.ts).

/** A recipient listed at a verified business, with one paid tip made there. */
async function paidAtBusiness(
  page: Page,
  request: Parameters<typeof payAtBusiness>[0],
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    name: 'The Yellow Chilli',
  });
  const { memberId } = await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Tobi',
  });
  const tip = await payAtBusiness(request, { handle: who.handle, memberId });
  return { who, business, memberId, ...tip };
}

const openReceipt = async (
  page: Page,
  { tipId, statusToken }: { tipId: string; statusToken: string },
) => {
  await page.goto(`/tip/${tipId}#t=${statusToken}`);
  await expect(
    page.getByRole('heading', { level: 1, name: /got your tip/ }),
  ).toBeVisible();
};

const noteOf = async (tipId: string) =>
  (
    await sql<{ tags: string[]; body: string | null }>(
      'SELECT tags, body FROM business_notes WHERE tip_id = $1',
      [tipId],
    )
  )[0];

test('after paying at a business, the supporter taps tags, writes a few kind words and sends a note', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const paid = await paidAtBusiness(page, request, testInfo);
  const supporter = await (await browser.newContext()).newPage();
  await openReceipt(supporter, paid);
  // The receipt is there whatever the note does.
  await expect(
    supporter.getByRole('region', { name: 'Your receipt' }),
  ).toBeVisible();
  const note = supporter.getByRole('region', {
    name: 'Thanks for tipping Tobi',
  });
  await expect(note.getByText('Want to say why? (optional)')).toBeVisible();
  const tags = note.getByRole('group', { name: 'What stood out' });
  // Positive tags only; no stars, nothing negative.
  await expect(tags.getByRole('button')).toHaveText([
    'Friendly',
    'Fast',
    'Went the extra mile',
    'Great advice',
    'Made my day',
  ]);
  const friendly = tags.getByRole('button', { name: 'Friendly' });
  const extra = tags.getByRole('button', { name: 'Went the extra mile' });
  await friendly.click();
  await extra.click();
  await expect(friendly).toHaveAttribute('aria-pressed', 'true');
  await expect(extra).toHaveAttribute('aria-pressed', 'true');
  await expect(tags.getByRole('button', { name: 'Fast' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(
    note.getByText(
      'Tobi and The Yellow Chilli will read this. Please keep it kind.',
    ),
  ).toBeVisible();
  const words = note.getByLabel('A few words (optional)');
  await words.fill('Call me on 0803 123 4567');
  await note.getByRole('button', { name: 'Send note' }).click();
  await expect(
    note.getByText('Links, emails and phone numbers can’t be sent.'),
  ).toBeVisible();
  await expect(words).toHaveAttribute('aria-invalid', 'true');
  await words.fill('He fixed our order in five minutes.');
  await expect(note.getByText('35 of 280')).toBeVisible();
  await expectAccessible(supporter);
  await note.getByRole('button', { name: 'Send note' }).click();
  await expect(supporter.getByText('Sent. Thank you.')).toBeVisible();
  expect(await noteOf(paid.tipId)).toEqual({
    tags: ['friendly', 'extra_mile'],
    body: 'He fixed our order in five minutes.',
  });
  await expectAccessible(supporter);
  // Written once: the receipt no longer asks.
  await supporter.reload();
  await expect(
    supporter.getByRole('heading', { level: 1, name: /got your tip/ }),
  ).toBeVisible();
  await expect(
    supporter.getByRole('heading', { name: 'Thanks for tipping Tobi' }),
  ).toHaveCount(0);
});

test('Skip hides the note for this receipt; nothing is sent and the receipt stays', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const paid = await paidAtBusiness(page, request, testInfo);
  const supporter = await (await browser.newContext()).newPage();
  await openReceipt(supporter, paid);
  const heading = supporter.getByRole('heading', {
    name: 'Thanks for tipping Tobi',
  });
  await expect(heading).toBeVisible();
  // Nothing chosen: the note asks for a tag or a few words, and sends nothing.
  await supporter.getByRole('button', { name: 'Send note' }).click();
  await expect(
    supporter.getByText('Choose what stood out, or write a few words.'),
  ).toBeVisible();
  await supporter.getByRole('button', { name: 'Skip' }).click();
  await expect(heading).toHaveCount(0);
  await expect(
    supporter.getByRole('region', { name: 'Your receipt' }),
  ).toBeVisible();
  await supporter.reload();
  await expect(
    supporter.getByRole('heading', { level: 1, name: /got your tip/ }),
  ).toBeVisible();
  await expect(heading).toHaveCount(0);
  expect(await noteOf(paid.tipId)).toBeUndefined();
});

test('a plain tip, not made at a business, asks for no note', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const tip = await payAtBusiness(request, { handle: who.handle });
  const supporter = await (await browser.newContext()).newPage();
  await openReceipt(supporter, tip);
  await expect(
    supporter.getByRole('region', { name: 'Your receipt' }),
  ).toBeVisible();
  await expect(
    supporter.getByRole('button', { name: 'Send note' }),
  ).toHaveCount(0);
});

test('the person reads their notes on the Work page and reports one; TipMe staff reveal and remove it', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const paid = await paidAtBusiness(page, request, testInfo);
  const supporter = await (await browser.newContext()).newPage();
  await openReceipt(supporter, paid);
  await supporter
    .getByRole('group', { name: 'What stood out' })
    .getByRole('button', { name: 'Made my day' })
    .click();
  await supporter.getByLabel('A few words (optional)').fill('Rude words here.');
  await supporter.getByRole('button', { name: 'Send note' }).click();
  await expect(supporter.getByText('Sent. Thank you.')).toBeVisible();

  // The Work page draws each membership from B3's real GET /v1/me/work.
  await page.goto('/dashboard/work');
  const notes = page
    .locator('.work-section')
    .filter({ has: page.getByRole('heading', { name: 'Notes about you' }) });
  await expect(notes.getByText('Rude words here.')).toBeVisible();
  await expect(notes.getByText('Made my day')).toBeVisible();
  await notes.getByRole('button', { name: 'Report this note' }).click();
  await notes.getByRole('radio', { name: 'Abusive or threatening' }).check();
  await expect(
    notes.getByText(
      'The Yellow Chilli stops seeing it at once, and TipMe looks at it privately.',
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await notes.getByRole('button', { name: 'Send report' }).click();
  await expect(
    page.getByText('Reported. The Yellow Chilli no longer sees that note.'),
  ).toBeVisible();
  await expect(
    notes.getByText(
      'Reported. Hidden from The Yellow Chilli until TipMe looks at it.',
    ),
  ).toBeVisible();
  const [issue] = await sql<{ id: string }>(
    `SELECT id FROM issues WHERE kind = 'business_note_reported' AND subject->>'tipId' = $1`,
    [paid.tipId],
  );
  expect(issue).toBeTruthy();

  // TipMe staff: the words show only after a reasoned reveal; then remove it.
  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.goto(`/ops/issues/${issue!.id}`);
  const section = staff
    .locator('.ops-section')
    .filter({ hasText: 'The reported note' });
  await expect(section.getByText('Rude words here.')).toHaveCount(0);
  // The usual Resolve is not offered: deciding the note resolves the issue.
  await expect(staff.getByRole('button', { name: 'Resolve…' })).toHaveCount(0);
  await section.getByRole('button', { name: 'Reveal the note' }).click();
  await section
    .getByLabel('Why do you need to read it?')
    .fill('Reviewing the member’s report.');
  await section.getByRole('button', { name: 'Reveal' }).click();
  await expect(section.getByText('Rude words here.')).toBeVisible();
  await expectAccessible(staff);
  await section.getByRole('button', { name: 'Remove it…' }).click();
  await section
    .getByLabel('Why remove it?')
    .fill('It is abusive about the person.');
  await section.getByRole('button', { name: 'Remove note' }).click();
  await expect(
    section.getByText(/Removed: the business never sees it again/).first(),
  ).toBeVisible();
  const [flag] = await sql<{ outcome: string }>(
    'SELECT outcome FROM business_note_flags WHERE tip_id = $1',
    [paid.tipId],
  );
  expect(flag?.outcome).toBe('removed');

  // The person still sees the note's place, not its words.
  await page.reload();
  await expect(notes.getByText('Removed by TipMe')).toBeVisible();
  await expect(notes.getByText('Rude words here.')).toHaveCount(0);
});
