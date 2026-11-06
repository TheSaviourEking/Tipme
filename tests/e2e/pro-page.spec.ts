import path from 'node:path';
import { expect, test } from '@playwright/test';

// The public Pro page, built to the PagePro board. Pro is granted by staff; there is no price.

test('the Pro page flips a sample page between Free and Pro', async ({
  page,
}) => {
  await page.goto('/pro');
  const plan = page.getByRole('radiogroup', { name: 'Plan' });
  await expect(plan.getByRole('radio', { name: 'Free' })).toBeChecked();
  const main = page.locator('main');
  await expect(main.getByText('Stays as you claimed it.')).toBeVisible();
  await expect(
    main.getByText('usetipme.xyz/@ada', { exact: true }),
  ).toBeVisible();

  await plan.getByRole('radio', { name: 'Pro' }).click();
  await expect(plan.getByRole('radio', { name: 'Pro' })).toBeChecked();
  await expect(main.getByText('Changed 0 of 3 times.')).toBeVisible();
  const change = main.getByRole('button', { name: 'Change it' });
  const handles = ['adacuts', 'adaedits', 'adaokafor'];
  for (const [index, handle] of handles.entries()) {
    await change.click();
    await expect(
      main.getByText(`usetipme.xyz/@${handle}`, { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText(`Changed ${index + 1} of 3 times.`),
    ).toBeVisible();
  }
  // Stops after three changes, and says so.
  await expect(change).toHaveAttribute('aria-disabled', 'true');
  // Playwright waits on aria-disabled controls, so the press is forced: it must do nothing.
  await change.click({ force: true });
  await expect(
    main.getByText('usetipme.xyz/@adaokafor', { exact: true }),
  ).toBeVisible();

  await plan.getByRole('radio', { name: 'Free' }).click();
  await expect(main.getByText('Stays as you claimed it.')).toBeVisible();
  await expect(
    main.getByText('usetipme.xyz/@ada', { exact: true }),
  ).toBeVisible();
});

test('Pro shows no price until staff set one', async ({ page }) => {
  await page.goto('/pro');
  const plan = page.getByRole('radiogroup', { name: 'Plan' });
  for (const name of ['Free', 'Pro']) {
    await plan.getByRole('radio', { name }).click();
    // The sample card shows the standard tip amounts; no amount sits in the plan's own words.
    const text = (await page.locator('main .pro-plan').innerText()) ?? '';
    expect(text).not.toMatch(/₦\s?0\b/);
    expect(text).not.toMatch(/₦/);
  }
  await plan.getByRole('radio', { name: 'Pro' }).click();
  const ask = page.getByRole('link', { name: 'Ask for Pro' });
  await expect(ask).toHaveAttribute(
    'href',
    'mailto:support@usetipme.xyz?subject=TipMe%20Pro',
  );
  await expect(page.locator('main')).not.toContainText('₦0');
});

test('both plans keep 10%', async ({ page }) => {
  await page.goto('/pro');
  await expect(
    page.getByText('TipMe keeps 10% of each tip on both plans.'),
  ).toBeVisible();
});

test('the sample QR codes on the Pro page scan to Ada’s page', async ({
  page,
}) => {
  await page.goto('/pro');
  await page.addScriptTag({
    path: path.join(process.cwd(), 'apps/web/node_modules/jsqr/dist/jsQR.js'),
  });
  for (const file of ['qr-standard', 'qr-hearts']) {
    const decoded = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, 400, 400);
      context.drawImage(image, 0, 0, 400, 400);
      const { data } = context.getImageData(0, 0, 400, 400);
      const jsQR = (
        window as unknown as {
          jsQR: (
            d: Uint8ClampedArray,
            w: number,
            h: number,
          ) => { data: string } | null;
        }
      ).jsQR;
      return jsQR(data, 400, 400)?.data ?? null;
    }, `/pro/${file}.png`);
    expect(decoded, file).toBe('https://usetipme.xyz/@ada');
  }
});

test('the Pro page says what animated covers do on each plan', async ({
  page,
}) => {
  await page.goto('/pro');
  const main = page.locator('main');
  const plan = page.getByRole('radiogroup', { name: 'Plan' });
  const once = main.getByRole('button', { name: 'Plays once' });
  const loop = main.getByRole('button', { name: 'Slow loop' });
  // Free: three covers that play once; the loop is shown and cannot be used.
  await expect(
    main.getByText('3 animated covers that play once.'),
  ).toBeVisible();
  await expect(once).toHaveAttribute('aria-pressed', 'true');
  await expect(loop).toHaveAttribute('aria-disabled', 'true');
  await loop.click({ force: true });
  await expect(loop).toHaveAttribute('aria-pressed', 'false');

  await plan.getByRole('radio', { name: 'Pro' }).click();
  await expect(
    main.getByText('Every design in every colour. Slow loop or Plays once.'),
  ).toBeVisible();
  await expect(loop).not.toHaveAttribute('aria-disabled', 'true');
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  // The sample is the real cover, not a drawing of one.
  await expect(main.locator('.pro-cover .profile-cover')).toHaveAttribute(
    'data-cover-play',
    'loop',
  );
});

test('the Pro page sample cover moves only when motion is allowed', async ({
  page,
}) => {
  const running = () =>
    page
      .locator('.pro-cover *')
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) =>
            node
              .getAnimations()
              .some((animation) => animation.playState === 'running'),
          ).length,
      );
  const plan = page.getByRole('radiogroup', { name: 'Plan' });
  // The suite defaults to reduced motion: the sample is a still picture on both plans.
  await page.goto('/pro');
  await expect(page.locator('.pro-cover .cover-fx').first()).toBeAttached();
  for (const name of ['Free', 'Pro']) {
    await plan.getByRole('radio', { name }).click();
    expect(await running(), name).toBe(0);
  }
  // With motion allowed, the same cover plays.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/pro');
  await expect.poll(running).toBeGreaterThan(0);
});
