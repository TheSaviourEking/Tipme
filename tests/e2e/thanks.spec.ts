import { expect, test, type Browser, type Page } from '@playwright/test';
import { tipFromProfile } from '../shared/tip-flow';
import { expectAccessible, signUpRecipient } from './helpers';
import { makePagePro, sql } from './ops-helpers';

// "Make it yours": the recipient's thank-you line on the supporter's receipt (pretend payments
// only). The line is set here as stored state; Settings is tested in make-it-yours.spec.ts.

const LINE = 'Thank you for backing my channel.';

const setPage = (handle: string, set: string, values: unknown[] = []) =>
  sql(`UPDATE profiles SET ${set} WHERE handle_lower = $1`, [
    handle,
    ...values,
  ]);

/** A visitor tips the page and lands on the paid receipt, left open for the test. */
async function paidReceipt(browser: Browser, handle: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await expect(async () => {
    await page.goto(`/@${handle}`);
    await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
  await tipFromProfile(page);
  await expect(
    page.getByRole('heading', { name: 'Ada Okafor got your tip.' }),
  ).toBeVisible({ timeout: 20_000 });
  return page;
}

test('a supporter reads the recipient’s thank-you line under "got your tip."', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPage(handle, `display_name = 'Ada Okafor', thanks_line = $2`, [
    LINE,
  ]);
  const receipt = await paidReceipt(browser, handle);
  const slip = receipt.getByRole('figure');
  await expect(slip).toHaveCount(1);
  await expect(slip.locator('blockquote')).toHaveText(LINE);
  await expect(slip).toHaveAttribute('data-style', 'paper');
  await expect(slip.locator('figcaption')).toHaveCount(0);
  // The slip sits under the heading, before the receipt.
  const order = await receipt.evaluate(() => {
    const at = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().top ?? -1;
    return [at('h1'), at('.thanks-slip'), at('.tip-thanks__receipt')];
  });
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
  await expectAccessible(receipt);
});

test('a Pro night card is signed with the first name, and is plain paper after the page leaves Pro', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await (await makePagePro(browser, handle, testInfo)).close();
  await setPage(
    handle,
    `display_name = 'Ada Okafor', thanks_line = $2, thanks_style = 'night', thanks_signed = true`,
    [LINE],
  );
  const receipt = await paidReceipt(browser, handle);
  const slip = receipt.getByRole('figure');
  await expect(slip).toHaveAttribute('data-style', 'night');
  await expect(slip.locator('figcaption')).toHaveText('Ada');
  // No dash in the signature, drawn or written: only a short rule drawn with a border.
  const signature = await slip.locator('figcaption').evaluate((caption) => ({
    text: (caption as HTMLElement).innerText,
    before: getComputedStyle(caption, '::before').content,
  }));
  expect(signature.text).not.toMatch(/[\u2013\u2014]/);
  expect(signature.before).not.toMatch(/[\u2013\u2014-]|\\20(13|14)/);
  await expectAccessible(receipt);

  await setPage(handle, `plan = 'free'`);
  await receipt.reload();
  await expect(receipt.getByRole('figure')).toHaveAttribute(
    'data-style',
    'paper',
  );
  await expect(receipt.getByRole('figure').locator('figcaption')).toHaveCount(
    0,
  );
});

test('no line means no slip, and the receipt reads exactly as before', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPage(handle, `display_name = 'Ada Okafor'`);
  const receipt = await paidReceipt(browser, handle);
  await expect(receipt.getByRole('figure')).toHaveCount(0);
  await expect(receipt.locator('.thanks-slip')).toHaveCount(0);
  await expect(
    receipt.getByText(/^.+2,000, confirmed by our payment partner\.$/),
  ).toBeVisible();
  await expect(
    receipt.getByRole('region', { name: 'Your receipt' }),
  ).toBeVisible();
});

test('the slip has a visible edge in forced colours', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPage(handle, `display_name = 'Ada Okafor', thanks_line = $2`, [
    LINE,
  ]);
  const receipt = await paidReceipt(browser, handle);
  await receipt.emulateMedia({ forcedColors: 'active' });
  const edge = await receipt
    .locator('.thanks-slip')
    .evaluate((slip) => getComputedStyle(slip).borderTopStyle);
  expect(edge).not.toBe('none');
});
