import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import {
  contrastProblems,
  geometryProblems,
  settled,
  studioModules,
} from './studio-probes';

// Page Studio styles, PR 2a (spec 2026-11-17-page-studio-styles §8, §9, §13, §14.3). Each style's
// lab example (LAB_STYLE_EXAMPLES: default accent, natural mode, a generated cover photo, a text,
// a quote, three photos, links on) renders through the real StudioStylePage around the real tip
// form. Only the styles drawn so far are listed; each later style PR adds its id here. Classic
// (PR 2b, §9.1) is today's page with its choices: its root is `main.profile-page`, its form today's.
const STYLES = ['classic', 'clear', 'journal', 'linen'] as const;
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
  // No shadow in dark (§9.1): the valid no-op, a transparent zero shadow, never a visible one.
  for (const selector of [
    '.profile-composer .appreciation-card',
    '.composer-submit',
    '.tm-amount-choice input:checked + span',
  ])
    expect(await styleOf(selector, 'box-shadow'), selector).toMatch(
      /^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/,
    );
  await expectAccessible(page);
  // An error in dark (the canvas draws none): readable, the field's edge too.
  await page.getByLabel(/^Other amount/).fill('1,000');
  await page.locator('form').getByRole('button', { name: /^Tip/ }).click();
  await expect(page.locator('.tm-field-error').first()).toBeVisible();
  expect(await contrastProblems(page, '.profile-page')).toEqual([]);
  // The invalid field keeps its red edge in dark: the shadow list survives Classic's dark
  // shadows (a valid no-op, not `none`, which would drop the whole list).
  await expect(page.getByLabel(/^Other amount/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(
    await page
      .getByLabel(/^Other amount/)
      .evaluate((el) => getComputedStyle(el).boxShadow),
  ).toContain('rgb(194, 56, 44) 3px 0px 0px 0px inset');
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

// Journal and Linen (PR 2c, §9.3, §9.8, §9.10).
const familyOf = (selector: string, page: Page) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);

test('Journal sets a Hausa name wholly in Inter 700 and the rest of the page in Source Serif 4', async ({
  page,
}) => {
  const name = 'Ɗanlami Ƙwairanga Ɓello';
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(
    `/dev/studio-lab?style=journal&name=${encodeURIComponent(name)}`,
  );
  await ready(page);
  const heading = page.getByRole('heading', { level: 1, name });
  const face = await heading.evaluate((h) => {
    const all = [h, ...h.querySelectorAll('*')].map((el) => {
      const cs = getComputedStyle(el);
      return `${cs.fontFamily}|${cs.fontWeight}`;
    });
    return [...new Set(all)];
  });
  // One face for the whole name: Studio Inter at 700, never a letter-by-letter mix.
  expect(face).toHaveLength(1);
  expect(face[0]).toMatch(/^"?Studio Inter"?,/);
  expect(face[0]).toMatch(/\|700$/);
  // The rest keeps the style: the bio and the section titles in Source Serif 4.
  expect(await familyOf('.studio-bio', page)).toMatch(
    /^"?Studio Source Serif 4"?,/,
  );
  expect(await familyOf('.studio-title', page)).toMatch(
    /^"?Studio Source Serif 4"?,/,
  );
  // The face really loaded (not a fallback standing in).
  expect(
    await page.evaluate(() =>
      document.fonts.check("20px 'Studio Source Serif 4'"),
    ),
  ).toBe(true);
});

test('Journal on desktop puts the first block in the left column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=journal');
  await ready(page);
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
  const [identity, tip, links, first, second, top] = await Promise.all([
    box('.studio-identity'),
    box('.studio-tip'),
    box('.studio-links'),
    box('.studio-section >> nth=0'),
    box('.studio-section >> nth=1'),
    box('.studio-top'),
  ]);
  // The left column (420): identity, Tip, links, then the first block.
  for (const part of [tip, links, first]) {
    expect(Math.round(part.left)).toBe(Math.round(identity.left));
    expect(Math.round(part.right - part.left)).toBe(420);
  }
  expect(first.top).toBeGreaterThan(links.bottom);
  // The other blocks flow in the right column, 96 px across, from the top of the split.
  expect(Math.round(second.left)).toBe(Math.round(identity.right) + 96);
  expect(second.top).toBeLessThan(links.top);
  // The top row spans the whole 1120 content width.
  expect(Math.round(top.right - top.left)).toBe(1120);
  // On a desktop the top row carries the handle, and the avatar sits above the name (72 px).
  await expect(page.locator('.studio-top .studio-top__handle')).toBeVisible();
  await expect(page.locator('.studio-top .studio-avatar')).toBeHidden();
  const avatar = await box('.studio-identity .studio-avatar');
  expect(Math.round(avatar.right - avatar.left)).toBe(72);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.studio-top .studio-avatar')).toBeVisible();
  await expect(page.locator('.studio-top .studio-top__handle')).toBeHidden();
  await expect(page.locator('.studio-identity .studio-avatar')).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await geometryProblems(page)).toEqual([]);
});

test('Linen frames a photo cover with a mat and no caption', async ({
  page,
}) => {
  const { contracts } = await studioModules();
  const mat = contracts.STUDIO_STYLES.linen.neutrals.light.mat as string;
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  for (const [width, frameWidth, photoHeight] of [
    [390, 358, 204],
    [1440, 600, 420],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev/studio-lab?style=linen');
    await ready(page);
    const cover = page.locator('.studio-cover[data-cover="photo"]');
    const frame = await cover.evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        width: r.width,
        background: cs.backgroundColor,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
        radius: cs.borderTopLeftRadius,
        padding: cs.paddingTop,
      };
    });
    expect(frame.background, `${width}`).toBe(rgb(mat));
    expect(frame.border, `${width}`).toBe('1px solid');
    expect(frame.radius, `${width}`).toBe('20px');
    expect(frame.padding, `${width}`).toBe('6px');
    expect(Math.round(frame.width), `${width}`).toBe(frameWidth);
    if (width === 390) expect(Math.round(frame.left)).toBe(16);
    const photo = await cover.locator('img').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        height: r.height,
        radius: getComputedStyle(el).borderTopLeftRadius,
      };
    });
    expect(Math.round(photo.height), `${width}`).toBe(photoHeight);
    expect(photo.radius, `${width}`).toBe('14px');
    // The canvas's italic caption has no data source and is left out (§9.8).
    await expect(page.locator('.studio-cover figcaption')).toHaveCount(0);
    await expect(page.locator('.studio-cover')).toHaveText('');
  }
});

test('chipOn follows the accent', async ({ page }) => {
  const { contracts } = await studioModules();
  const want = contracts.studioTokens('journal', 'rose').light.chipOn as string;
  const channels = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=journal&accent=rose');
  await ready(page);
  await page.locator('.tm-amount-choice').first().click();
  const got = await page
    .locator('.tm-amount-choice input:checked + span')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(got);
  expect(rgb, got).not.toBeNull();
  const ours = rgb!.slice(1, 4).map(Number);
  // The Task 2 OKLab mix of Rose on Journal's bg, within one unit per channel.
  channels(want).forEach((v, i) =>
    expect(Math.abs(ours[i]! - v), `${got} vs ${want}`).toBeLessThanOrEqual(1),
  );
  // And it is Rose's tint, not Green's (the board's default).
  expect(want).not.toBe(contracts.studioTokens('journal', null).light.chipOn);
});
