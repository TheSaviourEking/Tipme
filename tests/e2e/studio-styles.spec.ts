import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { contrastProblems, geometryProblems, settled } from './studio-probes';

// Page Studio styles, PR 2a (spec 2026-11-17-page-studio-styles §8, §9, §13, §14.3). Each style's
// lab example (LAB_STYLE_EXAMPLES: default accent, natural mode, a generated cover photo, a text,
// a quote, three photos, links on) renders through the real StudioStylePage around the real tip
// form. Only the styles drawn so far are listed; each later style PR adds its id here. Classic
// (PR 2b, §9.1) is today's page with its choices: its root is `main.profile-page`, its form today's.
const STYLES = ['classic', 'clear'] as const;
const rootOf = (style: string) =>
  style === 'classic' ? '.profile-page' : '.studio';
const WIDTHS = [320, 390, 768, 1024, 1440];
// §9.10's three names: Yoruba tone marks with dots below, a hyphenated double name, Hausa hooks.
const LONG_NAMES = [
  'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀',
  'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí',
  'Ɗanlami Ƙwairanga Ɓello',
];

const ready = async (page: Page) => {
  await page.locator('[data-style]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
};

for (const style of STYLES) {
  test(`${style} renders cleanly at 320, 390, 768, 1024 and 1440, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (const mode of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/dev/studio-lab?style=${style}&mode=${mode}`);
      await ready(page);
      await expect(page.locator(rootOf(style))).toHaveAttribute(
        'data-mode',
        mode,
      );
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await geometryProblems(page, rootOf(style)),
          `${mode} at ${width}px`,
        ).toEqual([]);
        expect(
          await contrastProblems(page, rootOf(style)),
          `${mode} at ${width}px`,
        ).toEqual([]);
        expect(await fitsViewport(page), `${mode} at ${width}px`).toBe(true);
        if (width === 390 || width === 1440) await expectAccessible(page);
      }
    }
  });

  test(`${style} sets long names in one face without overflow at 320 and 390`, async ({
    page,
  }) => {
    for (const name of LONG_NAMES) {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(
        `/dev/studio-lab?style=${style}&name=${encodeURIComponent(name)}`,
      );
      await ready(page);
      const heading = page.getByRole('heading', { level: 1, name });
      await expect(heading).toBeVisible();
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await settled(page);
        expect(
          await geometryProblems(page, rootOf(style)),
          `${name} at ${width}px`,
        ).toEqual([]);
        // One face for the whole name: every text run inside the heading computes the same
        // font-family, and the heading's box holds its text (no word pokes out).
        const faces = await heading.evaluate((h) => {
          const all = [h, ...h.querySelectorAll('*')].map(
            (el) => getComputedStyle(el).fontFamily,
          );
          return {
            families: [...new Set(all)],
            fits: h.scrollWidth <= h.clientWidth + 1,
          };
        });
        expect(faces.families, `${name} at ${width}px`).toHaveLength(1);
        expect(faces.fits, `${name} at ${width}px`).toBe(true);
      }
    }
  });

  test(`${style} keeps the tip form's behaviour`, async ({ page }) => {
    // The standard page's form, read on a seeded Free page (the lab sends the same standard
    // amounts, since it passes none).
    const read = async () => {
      const form = page
        .locator('form')
        .filter({ has: page.locator('fieldset') });
      const amounts = await form
        .locator('.tm-amount-choice input')
        .evaluateAll((inputs) =>
          inputs
            .filter((i) => (i as HTMLInputElement).value !== 'other')
            .map((i) => i.getAttribute('aria-label')),
        );
      return { form, amounts };
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/@tobi');
    const standard = await read();
    const standardOther = await page
      .getByLabel(/^Other amount/)
      .evaluate((i) => (i as HTMLInputElement).labels?.[0]?.textContent);
    await page.getByLabel(/^Other amount/).fill('1,000');
    await standard.form.getByRole('button', { name: /^Tip/ }).click();
    const standardError = await standard.form
      .locator('.tm-field-error')
      .first()
      .textContent();
    const standardFee = await standard.form
      .locator('.composer-trust, .composer-action__partner')
      .allTextContents();

    await page.goto(`/dev/studio-lab?style=${style}`);
    await ready(page);
    const styled = await read();
    expect(styled.amounts).toEqual(standard.amounts);
    expect(styled.amounts.length).toBeGreaterThan(0);
    if (style === 'classic') {
      // Classic keeps today's form: "Other amount", shown as on the standard page, no "Custom".
      await expect(
        styled.form.getByRole('radio', { name: 'Custom' }),
      ).toHaveCount(0);
      const other = page.getByLabel(/^Other amount/);
      await expect(other).toBeVisible();
      expect(
        await other.evaluate(
          (i) => (i as HTMLInputElement).labels?.[0]?.textContent,
        ),
      ).toBe(standardOther);
      await other.fill('1,000');
      await styled.form.getByRole('button', { name: /^Tip/ }).click();
      await expect(styled.form.locator('.tm-field-error').first()).toHaveText(
        standardError!,
      );
      expect(
        await styled.form
          .locator('.composer-trust, .composer-action__partner')
          .allTextContents(),
      ).toEqual(standardFee);
      await styled.form.locator('.tm-amount-choice').first().click();
      await expect(
        styled.form.getByRole('button', { name: /^Tip/ }),
      ).toContainText(styled.amounts[0]!.replace(' NGN', ''));
      return;
    }
    // The fourth choice reads "Custom" and reveals today's Other-amount field.
    const custom = styled.form.getByRole('radio', { name: 'Custom' });
    await expect(custom).toHaveCount(1);
    const other = page.getByLabel(/^Other amount/);
    await expect(other).toBeHidden();
    // From the keyboard, arrowing onto Custom reveals the field but leaves focus in the group
    // (WCAG 3.2.2: choosing is not a change of context).
    const first = styled.form.getByRole('radio').first();
    await first.focus();
    for (let i = 0; i < styled.amounts.length; i += 1)
      await page.keyboard.press('ArrowRight');
    await expect(custom).toBeChecked();
    await expect(custom).toBeFocused();
    await expect(other).toBeVisible();
    // A click on Custom takes the supporter straight to the field.
    await first.check({ force: true });
    await expect(other).toBeHidden();
    await styled.form.locator('label', { hasText: 'Custom' }).click();
    await expect(custom).toBeChecked();
    await expect(other).toBeVisible();
    await expect(other).toBeFocused();
    expect(
      await other.evaluate(
        (i) => (i as HTMLInputElement).labels?.[0]?.textContent,
      ),
    ).toBe(standardOther);
    // A below-minimum amount shows today's error, word for word.
    await other.fill('1,000');
    await styled.form
      .locator('.composer-action')
      .getByRole('button', { name: /^Tip/ })
      .click();
    await expect(styled.form.locator('.tm-field-error').first()).toHaveText(
      standardError!,
    );
    // The lines beside the Tip button are the standard page's.
    expect(
      await styled.form
        .locator('.composer-trust, .composer-action__partner')
        .allTextContents(),
    ).toEqual(standardFee);
    // Choosing a preset again hides the field and carries the amount into the label.
    await styled.form.locator('.tm-amount-choice').first().click();
    await expect(other).toBeHidden();
    await expect(
      styled.form
        .locator('.composer-action')
        .getByRole('button', { name: /^Tip/ }),
    ).toContainText(styled.amounts[0]!.replace(' NGN', ''));
  });
}

// Classic's choices (§9.1): the accent only where today's page uses purple, the Tip key in Classic's
// ink, dark and auto from the canvas's derived palette, and the three cover types.
test('classic takes an accent, dark or auto, and a cover type', async ({
  page,
}) => {
  const styleOf = (selector: string, prop: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  const selectedKey = '.tm-amount-choice input:checked + span';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=classic&accent=green&mode=light');
  await ready(page);
  await page.locator('.tm-amount-choice').first().click();
  expect(await styleOf(selectedKey, 'background-color')).toBe(
    'rgb(11, 122, 75)',
  );
  expect(await styleOf(selectedKey, 'color')).toBe('rgb(255, 255, 255)');
  expect(await styleOf('.brand__mark path[fill="#7A32F9"]', 'fill')).toBe(
    'rgb(11, 122, 75)',
  );
  // Focus is the accent; the Tip key stays black ink.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-primary')
        .trim(),
    ),
  ).toBe('#0b7a4b');
  expect(await styleOf('.composer-submit', 'background-color')).toBe(
    'rgb(0, 0, 0)',
  );
  expect(
    await styleOf('.profile-composer .appreciation-card', 'box-shadow'),
  ).not.toBe('none');

  await page.goto('/dev/studio-lab?style=classic&accent=green&mode=dark');
  await ready(page);
  expect(await styleOf('html', 'background-color')).toBe('rgb(20, 18, 16)');
  expect(await styleOf('.composer-submit', 'background-color')).toBe(
    'rgb(243, 242, 238)',
  );
  expect(await styleOf('.composer-submit', 'color')).toBe('rgb(20, 18, 16)');
  expect(
    await styleOf('.profile-composer .appreciation-card', 'box-shadow'),
  ).toBe('none');
  await expectAccessible(page);
  // An error in dark (the canvas draws none): readable, the field's edge too.
  await page.getByLabel(/^Other amount/).fill('1,000');
  await page.locator('form').getByRole('button', { name: /^Tip/ }).click();
  await expect(page.locator('.tm-field-error').first()).toBeVisible();
  expect(await contrastProblems(page, '.profile-page')).toEqual([]);
  await expectAccessible(page);

  // Auto follows the browser, with no script.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/dev/studio-lab?style=classic&mode=auto');
  await ready(page);
  expect(await styleOf('html', 'background-color')).toBe('rgb(20, 18, 16)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() => styleOf('html', 'background-color'), { timeout: 3000 })
    .toBe('rgb(243, 242, 238)');

  // Gradient: today's cover shape, two stops; plain: no band, nothing tucked under the header.
  await page.goto('/dev/studio-lab?style=classic&accent=lagoon&cover=gradient');
  await ready(page);
  expect(await styleOf('.classic-cover', 'background-image')).toMatch(
    /^linear-gradient\(135deg, rgb\([^)]+\), rgb\([^)]+\)\)$/,
  );
  expect(await styleOf('.classic-cover', 'border-top-left-radius')).toBe(
    '32px',
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev/studio-lab?style=classic&cover=plain');
    await ready(page);
    await expect(page.locator('.profile-cover')).toHaveCount(0);
    const [header, identity, panel] = await Promise.all(
      ['.site-header', '.profile-identity', '.profile-composer'].map((s) =>
        page.locator(s).evaluate((el) => el.getBoundingClientRect()),
      ),
    );
    expect(identity!.top, `${width}`).toBeGreaterThanOrEqual(header!.bottom);
    expect(panel!.top, `${width}`).toBeGreaterThanOrEqual(header!.bottom);
    expect(await geometryProblems(page, '.profile-page')).toEqual([]);
  }
});
