import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { startTip, tipFromProfile } from '../shared/tip-flow';
import { apiCall, env, newVisitor, signIn } from './client';

// The full release check (PR-010): the whole story on a `test` copy, as a tagged rehearsal.
// Everything it creates is hidden from totals and lists; the account is deleted at the end and
// the run is finished, which closes its issues. Ledger, history and audit stay as written.

const runApi = (path: string) =>
  fetch(`${env.api}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });

/**
 * Opens the admin grant. Codes are single-use, so a run right after another may meet a used step:
 * then it waits for the next 30-second step and tries again.
 */
async function openAdmin(page: Page) {
  const { totpAt } = await import('../../packages/domain/dist/index.js');
  const nav = page.getByRole('navigation', { name: 'Admin' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const step = BigInt(Math.floor(Date.now() / 30_000)) + BigInt(1);
    await page
      .getByLabel('Authenticator code')
      .fill(totpAt(env.opsTotpSecret, step));
    await page.getByRole('button', { name: 'Continue' }).click();
    const opened = await nav
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    while (BigInt(Math.floor(Date.now() / 30_000)) + BigInt(1) === step)
      await page.waitForTimeout(1000);
  }
  await expect(nav).toBeVisible();
}

async function tip(
  page: Page,
  handle: string,
  outcome: 'Pay' | 'Wrong amount',
  message?: string,
) {
  await page.goto(`/@${handle}?src=qr`);
  await expect(page).toHaveURL(new RegExp(`/@${handle}$`));
  await tipFromProfile(page, {
    outcome: new RegExp(`^${outcome}`),
    ...(message ? { message } : {}),
  });
}

test('the whole story works together, and leaves nothing visible behind', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  expect(env.token, 'RELEASE_CHECK_TOKEN').not.toBe('');
  expect(env.opsTotpSecret, 'RELEASE_OPS_TOTP_SECRET').not.toBe('');

  const run = await runApi('/v1/release/runs');
  expect(run.status, 'the copy must say RELEASE_KIND=test').toBe(201);
  const { runId } = (await run.json()).data as { runId: string };

  const staff = await (await newVisitor(browser)).newPage();
  const recipient = await (await newVisitor(browser)).newPage();
  const visitor = await (await newVisitor(browser)).newPage();
  const handle = `rc_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  // Its own domain each run: the pretend inbox shows only the first letter and the domain.
  const email = `r@rc-${randomUUID().slice(0, 8)}.example`;
  let accountCreated = false;

  try {
    // Staff first, so the admin numbers can be compared before and after.
    await signIn(staff, env.opsEmail, '/sign-in?next=/ops');
    await staff.waitForURL(/\/ops/);
    await openAdmin(staff);
    const health = async () =>
      (
        await (
          await apiCall(staff.request, 'GET', '/v1/ops/metrics/health')
        ).json()
      ).data.metrics;
    const before = await health();

    // A new recipient signs up, claims a (tagged) handle and goes live.
    await signIn(recipient, email, '/sign-up');
    await expect(recipient.getByLabel('Handle')).toBeVisible();
    accountCreated = true;
    const claim = await apiCall(
      recipient.request,
      'POST',
      '/v1/me/page',
      { handle },
      { 'x-tipme-rehearsal': runId },
    );
    expect(claim.status()).toBe(201);
    await recipient.goto('/dashboard/settings');
    await recipient.getByRole('button', { name: 'Make my page live' }).click();
    await expect(recipient.getByText('Your page is live')).toBeVisible();

    if (env.paymentProvider === 'bachs-sandbox') {
      // On the Bachs sandbox a new page cannot take tips until its owner completes Bachs' own
      // identity form, so the new page says so before a supporter starts, and its owner is told.
      await visitor.goto(`/@${handle}`);
      await expect(
        visitor.getByRole('heading', { name: /can’t receive tips just yet/ }),
      ).toBeVisible();
      await expect(
        visitor.getByRole('button', { name: /^Tip NGN/ }),
      ).toHaveCount(0);
      await recipient.goto('/dashboard');
      await expect(
        recipient
          .getByRole('region', { name: 'Needs your attention' })
          .getByText(/set up payments/i)
          .first(),
      ).toBeVisible();
      // A tip to the standing test page opens Bachs' sandbox checkout. It is never paid: that
      // would depend on Bachs' own page. The unpaid checkout expires; paid totals do not move.
      await visitor.goto(`/@${env.bachsHandle}?src=qr`);
      await startTip(visitor);
      await visitor.waitForURL(
        (url) =>
          url.hostname === 'bachs.io' || url.hostname.endsWith('.bachs.io'),
        { timeout: 30_000 },
      );
    } else {
      // A supporter scans the QR code and tips; the payment is confirmed.
      await tip(visitor, handle, 'Pay', 'Release check: thank you');
      await expect(
        visitor.getByRole('heading', { name: /paid|thank/i }).first(),
      ).toBeVisible({ timeout: 30_000 });

      // The recipient sees it, with a notification, and withdraws everything.
      await recipient.goto('/dashboard');
      await expect(
        recipient.getByText(/NGN 1,9\d\d\.\d\d|NGN [\d,]+\.\d\d/).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (
              await (
                await apiCall(recipient.request, 'GET', '/v1/me/notifications')
              ).json()
            ).data.length,
          {
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(0);

      // A provider problem: the next tip's amount is misreported.
      await tip(visitor, handle, 'Wrong amount');
      let issueId = '';
      await expect(async () => {
        const list = (
          await (
            await apiCall(
              staff.request,
              'GET',
              '/v1/ops/issues?includeRehearsal=1',
            )
          ).json()
        ).data as {
          id: string;
          summary: string;
          kind: string;
        }[];
        issueId =
          list.find(
            (i) =>
              i.kind === 'payment_mismatch' && i.summary.includes(`@${handle}`),
          )?.id ?? '';
        expect(issueId).not.toBe('');
      }).toPass({ timeout: 30_000 });
      await staff.goto(`/ops/issues/${issueId}`);
      await expect(staff.getByRole('heading', { level: 1 })).toHaveText(
        'Amount mismatch',
      );
      await staff.getByRole('button', { name: 'Resolve…' }).click();
      await staff
        .getByLabel('How was it resolved?')
        .fill(`Release check ${runId}`);
      await staff.getByRole('button', { name: 'Resolve issue' }).click();
      await expect(
        staff
          .locator('.ops-issue__status')
          .getByText('Resolved', { exact: true }),
      ).toBeVisible();

      // Withdraw everything, so the account can be deleted.
      const summary = (
        await (
          await apiCall(recipient.request, 'GET', '/v1/me/dashboard')
        ).json()
      ).data;
      const available = String(
        summary.balance?.availableMinor ?? summary.availableMinor ?? '0',
      );
      expect(BigInt(available)).toBeGreaterThan(BigInt(0));
      const withdrawal = await apiCall(
        recipient.request,
        'POST',
        '/v1/me/withdrawals',
        { amountMinor: available },
        {
          'idempotency-key': randomUUID(),
        },
      );
      expect([200, 201]).toContain(withdrawal.status());
    }

    // The admin numbers did not move: the rehearsal is invisible to them.
    const after = await health();
    expect(after.money).toEqual(before.money);
    expect(after.recipients).toEqual(before.recipients);
  } finally {
    // Clean up even when a step failed: delete the account (normal flow), then finish the run.
    if (accountCreated) {
      // Delete the account through the normal flow. TipMe refuses while money is still
      // confirming, and the deliberately misreported tip never confirms (by design), so then the
      // page is taken offline instead: synthetic, tagged and hidden from every view.
      let deleted = 0;
      await expect(async () => {
        deleted = (
          await apiCall(recipient.request, 'DELETE', '/v1/me/account', {
            confirm: 'DELETE',
          })
        ).status();
        expect([200, 204, 404, 409]).toContain(deleted);
      }).toPass({ timeout: 60_000 });
      if (deleted === 409) {
        const offline = await apiCall(
          recipient.request,
          'PUT',
          '/v1/me/page/state',
          {
            state: 'not_live',
          },
        );
        expect(offline.status()).toBe(200);
        console.log(
          `Release check: @${handle} kept offline (a rehearsal tip is still unresolved by design).`,
        );
      }
    }
    const finished = await runApi(`/v1/release/runs/${runId}/finish`);
    expect(finished.status).toBe(200);
  }
});
