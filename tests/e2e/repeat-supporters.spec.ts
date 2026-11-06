import { expect, test, type Page, type Request } from '@playwright/test';
import { tipFromProfile } from '../shared/tip-flow';
import { expectAccessible, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';

// Repeat supporters, the supporter's choice (Pro additions, option (a)). The tick box shows only on
// a Pro page once a name is typed, is off by default, and sends a random key kept in this browser
// for this recipient only. Any receipt of a recognised tip can stop it. Pretend payments only.

const TICK = 'Let Ada recognise me next time';
const HINT =
  'They’ll see that you’ve tipped before, and how often. You can stop this from any receipt.';
const STORE = 'tipme.supporters.v1';
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A new live recipient named Ada Okafor, on Pro unless asked otherwise. */
async function recipient(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  plan: 'pro' | 'free' = 'pro',
) {
  const { handle } = await signUpRecipient(page, testInfo);
  await sql(
    `UPDATE profiles SET display_name = 'Ada Okafor', plan = $2 WHERE handle_lower = $1`,
    [handle, plan],
  );
  return handle;
}

async function openDetails(page: Page, handle: string) {
  await expect(async () => {
    await page.goto(`/@${handle}`);
    await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.getByText('Add a message, reason or your name').click();
}

/** Taps Tip and returns the intent request's body, stopping it before any checkout opens. */
async function intentBody(page: Page) {
  let sent: Request | undefined;
  await page.route('**/v1/tip-intents', async (route) => {
    sent = route.request();
    await route.abort();
  });
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await expect.poll(() => sent).toBeTruthy();
  await page.unroute('**/v1/tip-intents');
  return sent?.postDataJSON() as Record<string, unknown>;
}

const storedKeys = (page: Page) =>
  page.evaluate((store) => {
    const raw = localStorage.getItem(store);
    return raw ? (JSON.parse(raw) as { keys: Record<string, string> }) : null;
  }, STORE);

test('Pro page: typing a name shows the tick, off; ticking sends supporterKey; emptying the name hides and unticks it', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await openDetails(visitor, handle);
  await expect(visitor.getByRole('checkbox', { name: TICK })).toHaveCount(0);
  const name = visitor.getByLabel('Your name (optional)');
  await name.fill('Chidi');
  const tick = visitor.getByRole('checkbox', { name: TICK });
  await expect(tick).toBeVisible();
  await expect(tick).not.toBeChecked();
  await expect(visitor.getByText(HINT)).toBeVisible();
  await expectAccessible(visitor);

  // Not ticked: no key is sent and none is made.
  const plain = await intentBody(visitor);
  expect(plain).toMatchObject({ payerDisplayLabel: 'Chidi' });
  expect(plain).not.toHaveProperty('supporterKey');
  expect(await storedKeys(visitor)).toBeNull();

  // Ticked: the key is made now, kept for this handle only, and sent.
  await openDetails(visitor, handle);
  await visitor.getByLabel('Your name (optional)').fill('Chidi');
  await visitor.getByRole('checkbox', { name: TICK }).check();
  const ticked = await intentBody(visitor);
  expect(ticked.supporterKey).toMatch(KEY);
  expect(await storedKeys(visitor)).toEqual({
    v: 1,
    keys: { [handle]: ticked.supporterKey },
  });

  // Emptying the name hides the box and unticks it: nothing is sent.
  await openDetails(visitor, handle);
  await visitor.getByLabel('Your name (optional)').fill('Chidi');
  await visitor.getByRole('checkbox', { name: TICK }).check();
  await visitor.getByLabel('Your name (optional)').fill('  ');
  await expect(visitor.getByRole('checkbox', { name: TICK })).toHaveCount(0);
  await visitor.getByLabel('Your name (optional)').fill('Chidi');
  await expect(visitor.getByRole('checkbox', { name: TICK })).not.toBeChecked();
  expect(await intentBody(visitor)).not.toHaveProperty('supporterKey');
});

test('the second tip from the same browser sends the same key; another recipient gets another', async ({
  page,
  browser,
}, testInfo) => {
  const first = await recipient(page, testInfo);
  const second = await recipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  expect(second).not.toBe(first);
  const visitor = await (await browser.newContext()).newPage();
  const keyFor = async (handle: string) => {
    await openDetails(visitor, handle);
    await visitor.getByLabel('Your name (optional)').fill('Chidi');
    await visitor.getByRole('checkbox', { name: TICK }).check();
    return (await intentBody(visitor)).supporterKey;
  };
  const one = await keyFor(first);
  expect(await keyFor(first)).toBe(one);
  const other = await keyFor(second);
  expect(other).toMatch(KEY);
  expect(other).not.toBe(one);
});

test('receipt: "Stop Ada recognising me" works, removes this handle\'s key, and moves focus to the result', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await openDetails(visitor, handle);
  await visitor.getByLabel('Your name (optional)').fill('Chidi');
  await visitor.getByRole('checkbox', { name: TICK }).check();
  await visitor.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await visitor.getByRole('button', { name: /^Tip ₦/ }).click();
  await visitor.waitForURL(/\/mock-checkout\//);
  await visitor.getByRole('button', { name: /^Pay/ }).click();
  await visitor.waitForURL(/\/tip\//);
  await expect(
    visitor.getByRole('heading', { name: 'Ada Okafor got your thanks.' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    visitor.getByText('Ada can recognise you next time.'),
  ).toBeVisible();
  await expectAccessible(visitor);
  expect((await storedKeys(visitor))?.keys[handle]).toMatch(KEY);

  await visitor
    .getByRole('button', { name: 'Stop Ada recognising me' })
    .click();
  const done = visitor.getByText(
    'Done. Ada won’t see your tips grouped any more.',
  );
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  await expect(
    visitor.getByRole('button', { name: 'Stop Ada recognising me' }),
  ).toHaveCount(0);
  expect((await storedKeys(visitor))?.keys[handle]).toBeUndefined();
  await expectAccessible(visitor);

  // The server agrees: a reload no longer offers it.
  await visitor.reload();
  await expect(
    visitor.getByRole('heading', { name: 'Ada Okafor got your thanks.' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    visitor.getByText('Ada can recognise you next time.'),
  ).toHaveCount(0);
});

test('Free page, or an API without recognition: no tick, today’s form', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'free');
  const visitor = await (await browser.newContext()).newPage();
  await openDetails(visitor, handle);
  await visitor.getByLabel('Your name (optional)').fill('Chidi');
  await expect(visitor.getByRole('checkbox', { name: TICK })).toHaveCount(0);
  await expect(visitor.getByText(HINT)).toHaveCount(0);
  const body = await intentBody(visitor);
  expect(body).not.toHaveProperty('supporterKey');
  expect(await storedKeys(visitor)).toBeNull();
  await expectAccessible(visitor);
});

test('a paid tip without the tick has no recognition line on its receipt', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await openDetails(visitor, handle);
  await visitor.goto(`/@${handle}`);
  await tipFromProfile(visitor, { name: 'Chidi' });
  await expect(
    visitor.getByRole('heading', { name: 'Ada Okafor got your thanks.' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    visitor.getByText('Ada can recognise you next time.'),
  ).toHaveCount(0);
  await expect(
    visitor.getByRole('button', { name: /recognising me/ }),
  ).toHaveCount(0);
});
