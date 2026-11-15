import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { startTip } from '../shared/tip-flow';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { codeFor, enrolOwner, secondOwner, sql } from './ops-helpers';

// TipMe for businesses, plan B9 Task 25: the whole release 1 journey, in order, through the real
// screens: apply, two staff verify, invite by link, accept, check in, print the sign, scan, pick,
// pay (pretend partner), note, what the business sees, report, restore, leave. Shares and team
// tips (release 2) are not used. Once at desktop width and once at 360px (@mobile). The owner's
// Business page is opened once and never reloaded after the tip: its updates arrive as live
// signals (Task 23).

// Three accounts, two staff and a payment in one test: well past one sign-up's budget.
test.setTimeout(300_000);

const REASON = 'Checked the name, address and contact today';

/** What the ledger owes the person (recipient_payable) against the tip's quoted net, in kobo. */
async function balanceAndNet(profileId: string, tipId: string) {
  const [row] = await sql<{ payable: string; net: string }>(
    `SELECT
       (SELECT COALESCE(SUM(CASE WHEN e.side = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
          FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
         WHERE a.code = 'recipient_payable' AND a.profile_id = $1)::text AS payable,
       (SELECT q.recipient_net_minor FROM tips t
          JOIN payment_intents i ON i.id = t.intent_id
          JOIN tip_quotes q ON q.id = i.quote_id
         WHERE t.id = $2)::text AS net`,
    [profileId, tipId],
  );
  return row!;
}

const opsSection = (page: Page, name: string) =>
  page
    .locator('.settings-section')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

async function journey(owner: Page, browser: Browser, testInfo: TestInfo) {
  // 1. Apply.
  await signUpRecipient(owner, testInfo, { live: false });
  await owner.goto('/dashboard/business/apply');
  const name = `Chilli ${randomUUID().slice(0, 6)}`;
  const slug = `chilli-${randomUUID().slice(0, 8)}`;
  await owner.getByLabel('Business name').fill(name);
  await owner.getByLabel('Address on TipMe', { exact: true }).fill(slug);
  await owner.getByLabel('Location name').fill('Victoria Island');
  await owner.getByLabel('Street address').fill('27 Ademola Adetokunbo, Lagos');
  await owner.getByRole('button', { name: 'Create business' }).click();
  await expect(owner.getByTestId('business-applied')).toBeVisible();
  const [business] = await sql<{ id: string }>(
    'SELECT id FROM businesses WHERE slug = $1',
    [slug],
  );
  const businessId = business!.id;
  const location = `/b/${slug}/victoria-island`;

  // 2. Two TipMe staff verify it: one asks, the other approves.
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await enrolOwner(staff, testInfo);
  const second = await secondOwner(browser, testInfo);
  await staff.goto(`/ops/businesses/${businessId}`);
  // The location's public page is one click away for staff; it isn't taking tips yet.
  await expect(
    staff
      .getByRole('list', { name: 'Locations' })
      .getByRole('link', { name: /Victoria Island’s public page/ }),
  ).toHaveAttribute('href', location);
  const verify = opsSection(staff, 'Verify');
  await verify.getByRole('button', { name: 'Verify…' }).click();
  await verify.getByLabel('What did you check?').fill(REASON);
  await verify.getByRole('button', { name: 'Verify this business' }).click();
  await expect(
    staff.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await second.page.goto('/ops/approvals');
  const card = second.page
    .getByRole('article')
    .filter({ hasText: `/b/${slug}` });
  await card.getByRole('button', { name: 'Approve…' }).click();
  await card.getByLabel('Authenticator code').fill(await codeFor(second));
  await card.getByRole('button', { name: 'Approve and run' }).click();
  await expect(card).toHaveCount(0);
  await second.context.close();
  await owner.goto('/dashboard/business');
  await expect(owner.getByTestId('business-status')).toHaveText(
    'Verified business',
  );
  await expect(owner.getByTestId('business-preview-note')).toHaveCount(0);

  // 3. Invite by a one-time link.
  await owner
    .getByRole('group', { name: 'How should we reach them?' })
    .getByLabel('Link')
    .check();
  await owner.getByRole('button', { name: 'Make a link' }).click();
  const link = await owner.getByRole('textbox', { name: 'Link' }).inputValue();
  await owner.getByRole('button', { name: 'Done' }).click();

  // 4. A second account, with its own live page, accepts.
  const personContext = await browser.newContext({
    viewport: owner.viewportSize() ?? undefined,
  });
  const person = await personContext.newPage();
  const who = await signUpRecipient(person, testInfo);
  const [account] = await sql<{ id: string }>(
    'SELECT id FROM profiles WHERE handle = $1',
    [who.handle],
  );
  const profileId = account!.id;
  // Signed in already: the link opens Work with the invitation.
  await person.goto(new URL(link).pathname + new URL(link).hash);
  await person.getByRole('button', { name: 'Accept' }).click();
  await expect(person.getByText(`You joined ${name}.`)).toBeVisible();
  await person.getByLabel('Shown as').fill('Kemi');
  await person.getByRole('button', { name: 'Save' }).click();
  await expect(person.getByText('Saved.')).toBeVisible();

  // 5. Check in.
  await person
    .getByRole('button', { name: 'Check in at Victoria Island' })
    .click();
  await expect(
    person.getByText(/^You’re on at Victoria Island since \d{2}:\d{2}\.$/),
  ).toBeVisible();

  // 6. Print the location's sign.
  const codes = owner.getByRole('region', { name: 'Codes' });
  await codes.getByRole('link', { name: 'Print Victoria Island sign' }).click();
  await expect(owner).toHaveURL(
    new RegExp(
      `/dashboard/business/codes/print\\?business=${businessId}&location=`,
    ),
  );
  await expect(
    owner.getByRole('img', {
      name: new RegExp(
        `^Sign for ${name} · Victoria Island: QR code for .+${location}$`,
      ),
    }),
  ).toBeVisible();
  // Back to the Business page, opened once: from here on it updates live.
  await owner.goto('/dashboard/business');
  const notes = owner.getByRole('region', { name: 'What customers say' });
  const week = owner.getByRole('region', { name: 'This week' });
  await expect(
    week.getByText(`No tips at Victoria Island this week.`),
  ).toBeVisible();

  // 7. A supporter scans, picks Kemi, pays with the pretend partner and leaves a note.
  const supporterContext = await browser.newContext({
    viewport: owner.viewportSize() ?? undefined,
  });
  const supporter = await supporterContext.newPage();
  await supporter.goto(`${location}?src=qr`);
  await expect(
    supporter.getByRole('heading', { level: 1, name }),
  ).toBeVisible();
  await expect(supporter.getByText('Verified business')).toBeVisible();
  expect(await fitsViewport(supporter)).toBe(true);
  await supporter.getByRole('link', { name: 'Kemi', exact: true }).click();
  await supporter.waitForURL(new RegExp(`${location}/${who.handle}`));
  await startTip(supporter);
  await supporter.waitForURL(/\/mock-checkout\//);
  await supporter.getByRole('button', { name: /^Pay/ }).click();
  await supporter.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  const tipId = new URL(supporter.url()).pathname.split('/')[2]!;
  const note = supporter.getByRole('region', {
    name: 'Thanks for tipping Kemi',
  });
  await note
    .getByRole('group', { name: 'What stood out' })
    .getByRole('button', { name: 'Friendly' })
    .click();
  await note.getByLabel('A few words (optional)').fill('Lovely service.');
  await note.getByRole('button', { name: 'Send note' }).click();
  await expect(supporter.getByText('Sent. Thank you.')).toBeVisible();
  await expectAccessible(supporter);
  const paid = await balanceAndNet(profileId, tipId);
  expect(paid.payable).toBe(paid.net);

  // 8. The business sees "Fewer than 3" for Kemi and the note, with its date only: without a reload.
  await expect(notes.getByText('“Lovely service.”')).toBeVisible({
    timeout: 20_000,
  });
  await expect(notes).toContainText('Kemi · Friendly');
  await expect(notes).not.toContainText(/\d{1,2}:\d{2}/);
  const table = week.getByRole('table', { name: 'Who got the most tips' });
  await expect(table.getByRole('row', { name: /Kemi/ })).toContainText(
    'Fewer than 3',
  );
  await expect(week.getByTestId('insights-total')).toHaveText('Fewer than 3');
  await expect(week).not.toContainText('₦');
  await expectAccessible(owner);
  expect(await fitsViewport(owner)).toBe(true);

  // 9. Kemi reports it from Work; the business stops seeing it.
  await person.goto('/dashboard/work');
  const mine = person
    .locator('.work-section')
    .filter({ has: person.getByRole('heading', { name: 'Notes about you' }) });
  await mine.getByRole('button', { name: 'Report this note' }).click();
  await mine.getByRole('radio', { name: 'Abusive or threatening' }).check();
  await mine.getByRole('button', { name: 'Send report' }).click();
  await expect(
    person.getByText(`Reported. ${name} no longer sees that note.`),
  ).toBeVisible();
  await expect(notes.getByText('“Lovely service.”')).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(await balanceAndNet(profileId, tipId)).toEqual(paid);

  // 10. TipMe staff restore it; the business sees it again.
  const [issue] = await sql<{ id: string }>(
    `SELECT id FROM issues WHERE kind = 'business_note_reported' AND subject->>'tipId' = $1`,
    [tipId],
  );
  await staff.goto(`/ops/issues/${issue!.id}`);
  const review = staff
    .locator('.ops-section')
    .filter({ hasText: 'The reported note' });
  // The words show only after a reasoned reveal; then staff decide.
  await review.getByRole('button', { name: 'Reveal the note' }).click();
  await review
    .getByLabel('Why do you need to read it?')
    .fill('Reviewing the member’s report.');
  await review.getByRole('button', { name: 'Reveal' }).click();
  await expect(review.getByText('Lovely service.')).toBeVisible();
  await review
    .getByRole('button', { name: 'Restore for the business…' })
    .click();
  await review.getByLabel('Why restore it?').fill('Kind words, not abusive.');
  await review.getByRole('button', { name: 'Restore note' }).click();
  await expect(
    review.getByText(/Restored: the business sees it again/).first(),
  ).toBeVisible();
  await expect(notes.getByText('“Lovely service.”')).toBeVisible({
    timeout: 20_000,
  });
  expect(await balanceAndNet(profileId, tipId)).toEqual(paid);

  // 11. Kemi leaves: the row and the note go, the location's total stays.
  await person.goto('/dashboard/work');
  await person.getByRole('button', { name: 'Leave Victoria Island' }).click();
  await person
    .getByRole('button', { name: 'Yes, leave Victoria Island' })
    .click();
  await expect(
    person.getByText('You don’t work anywhere on TipMe yet.'),
  ).toBeVisible();
  await expect(table.getByRole('row', { name: /Kemi/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(notes.getByText('“Lovely service.”')).toHaveCount(0);
  await expect(week.getByTestId('insights-total')).toHaveText('Fewer than 3');

  // Kemi's own copy still lists where they worked.
  await person.goto('/dashboard/settings#data');
  const download = person.waitForEvent('download');
  await person.getByRole('button', { name: 'Download where you work' }).click();
  const file = await readFile((await (await download).path())!, 'utf8');
  expect(file).toContain(`${name},Victoria Island,Kemi,`);
  expect(file).toMatch(/,You\r\n$/);

  // 12. Throughout, the person's balance is the tip's net: nothing went to the business.
  expect(await balanceAndNet(profileId, tipId)).toEqual(paid);
  for (const context of [personContext, supporterContext, staffContext])
    await context.close();
}

test('a business from applying to a person leaving', async ({
  page,
  browser,
}, testInfo) => journey(page, browser, testInfo));

test('a business from applying to a person leaving, at 360px @mobile', async ({
  page,
  browser,
}, testInfo) => journey(page, browser, testInfo));
