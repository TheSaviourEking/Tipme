import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { contrastProblems, geometryProblems, settled } from './studio-probes';

// Page Studio styles, PR 2a (spec 2026-11-17-page-studio-styles §8, §9, §13, §14.3). Each style's
// lab example (LAB_STYLE_EXAMPLES: default accent, natural mode, a generated cover photo, a text,
// a quote, three photos, links on) renders through the real StudioStylePage around the real tip
// form. Only the styles drawn so far are listed; each later style PR adds its id here.
const STYLES = ['clear'] as const;
const WIDTHS = [320, 390, 768, 1024, 1440];
// §9.10's three names: Yoruba tone marks with dots below, a hyphenated double name, Hausa hooks.
const LONG_NAMES = [
  'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀',
  'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí',
  'Ɗanlami Ƙwairanga Ɓello',
];

const ready = async (page: Page) => {
  await page.locator('.studio[data-style]').waitFor();
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
      await expect(page.locator('.studio')).toHaveAttribute('data-mode', mode);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        expect(await geometryProblems(page), `${mode} at ${width}px`).toEqual(
          [],
        );
        expect(await contrastProblems(page), `${mode} at ${width}px`).toEqual(
          [],
        );
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
        expect(await geometryProblems(page), `${name} at ${width}px`).toEqual(
          [],
        );
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
