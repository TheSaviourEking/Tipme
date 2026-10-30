import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { enrolOwner, withDatabase } from './ops-helpers';

const seal = Buffer.alloc(32, 8);

/** One sent email of a type, created at `at`, through the real queue and event operations. */
async function seedMail(type: string, data: unknown, at: Date, n: string) {
  await withDatabase(async (db, ops) => {
    const sealing = ops.mailSealing(seal);
    // In one transaction, so the worker never sees it queued and sends it a second time.
    await (
      db as { transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> }
    ).transaction(async (tx) => {
      const { id } = await ops.enqueueMail(tx, sealing, {
        type,
        to: `console-${n}@console.example`,
        data,
        dedupeKey: `e2e.console.${n}.${Date.now()}`,
        now: at,
      });
      await ops.recordMailEvent(tx, {
        messageId: id,
        kind: 'sent',
        provider: 'mock',
        occurredAt: at,
        type,
        category: type === 'tip_received' ? 'transactional' : 'security',
      });
      await (tx as { execute(sql: string): Promise<unknown> }).execute(
        `UPDATE mail_messages SET status = 'sent', provider = 'mock' WHERE id = '${id}'`,
      );
    });
  });
}

const tip = {
  firstName: 'Ada',
  netMinor: '180000',
  supporterLabel: 'Tobi',
  pretendPayment: true,
};

test('the console shows today’s emails, a message’s timeline, and compares with the period before', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const stamp = `${testInfo.workerIndex}${Date.now() % 100000}`;
  await seedMail('tip_received', tip, new Date(), `tip${stamp}`);
  // Yesterday's mail, so today has something to compare with.
  await seedMail(
    'tip_received',
    tip,
    new Date(Date.now() - 86_400_000),
    `old${stamp}`,
  );
  await seedMail(
    'email_verification_link',
    { token: 'sample-token-sample-token-sample-token-0001' },
    new Date(),
    `code${stamp}`,
  );

  await page.goto('/ops/email');
  await expect(
    page.getByRole('heading', { name: 'Email', level: 1 }),
  ).toBeVisible();
  await page.getByLabel('Period').selectOption('today');
  await expect(page.getByText(/vs all of yesterday/).first()).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await page.getByLabel('Type').selectOption('tip_received');
  const row = page
    .getByRole('button', { name: /Tip received to c•••@console\.example/ })
    .first();
  await row.click();
  const drawer = page.getByRole('region', { name: 'This email' });
  await expect(drawer.getByText(/Sent through/)).toBeVisible();
  await expectAccessible(page);

  // A sign-in or recovery email's content is never shown.
  await page.getByLabel('Type').selectOption('email_verification_link');
  await page
    .getByRole('button', {
      name: /Email verification link to c•••@console\.example/,
    })
    .first()
    .click();
  await drawer.getByRole('button', { name: 'View email' }).click();
  await expect(drawer.getByText(/Content withheld/)).toBeVisible();
});
