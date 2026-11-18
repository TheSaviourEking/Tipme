import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import {
  contrastProblems,
  geometryProblems,
  encodeDoc,
  settled,
  studioModules,
} from './studio-probes';

// Page Studio styles, PR 2a (spec 2026-11-17-page-studio-styles §8, §9, §13, §14.3). Each style's
// lab example (LAB_STYLE_EXAMPLES: default accent, natural mode, a generated cover photo, a text,
// a quote, three photos, links on) renders through the real StudioStylePage around the real tip
// form. Only the styles drawn so far are listed; each later style PR adds its id here. Classic
// (PR 2b, §9.1) is today's page with its choices: its root is `main.profile-page`, its form today's.
const STYLES = [
  'classic',
  'clear',
  'journal',
  'linen',
  'stage',
  'horizon',
  'signboard',
  'sprint',
  'tiles',
] as const;
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
    // Many page loads in one test: the burn-in runs it beside others.
    test.setTimeout(120_000);
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

// Ruling U: the board puts the identity, the Tip and the hairline link index ("Elsewhere", a
// block when it was drawn; §8 fixed it in Journal's left column) on the left, and every block on
// the right.
test('Journal on desktop puts the links on the left and every block on the right', async ({
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
  // The left column (420): identity, Tip, then the links.
  for (const part of [tip, links]) {
    expect(Math.round(part.left)).toBe(Math.round(identity.left));
    expect(Math.round(part.right - part.left)).toBe(420);
  }
  expect(links.top).toBeGreaterThan(tip.bottom);
  // Every block in the right column, 96 px across, from the top of the split.
  for (const section of [first, second]) {
    expect(Math.round(section.left)).toBe(Math.round(identity.right) + 96);
    expect(Math.round(section.right)).toBe(Math.round(top.right));
  }
  expect(first.top).toBeLessThan(tip.top);
  expect(second.top).toBeGreaterThan(first.bottom);
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

// Every kind of block, for the slot-width check below.
const IMG = (n: number) =>
  `0000${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
const ALL_KINDS = {
  v: 2,
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [
    {
      id: 'kindtxt1',
      kind: 'text',
      variant: 'paragraph',
      text: 'Studio time.',
    },
    { id: 'kindquo1', kind: 'quote', text: 'Sing it again.' },
    { id: 'kindpho1', kind: 'photo', imageId: IMG(2), alt: 'A stage' },
    {
      id: 'kindgal1',
      kind: 'gallery',
      images: [3, 4, 5].map((n) => ({ imageId: IMG(n), alt: `Photo ${n}` })),
    },
    { id: 'kindvid1', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
    {
      id: 'kindsvc1',
      kind: 'services',
      items: [{ name: 'Skin fade', priceMinor: '800000' }],
    },
    {
      id: 'kindevt1',
      kind: 'events',
      items: [{ date: '2099-12-31', title: 'Live set' }],
    },
  ],
};
/** The box each kind draws at its slot width. */
const DRAWN = {
  text: '.studio-text',
  quote: '.studio-quote',
  photo: '.studio-photo img',
  gallery: '.studio-strip li',
  video: '.studio-video',
  services: '.studio-list',
  events: '.studio-list',
} as const;

// Signboard's first section sits in its left column on a desktop (§9.5): a short one leads, so
// every kind is measured where the rest go, in the 600 column.
const LEAD = [
  { id: 'kindhed0', kind: 'text', variant: 'heading', text: 'First' },
  { id: 'kindtxt0', kind: 'text', variant: 'paragraph', text: 'Hello.' },
  { id: 'kindhed1', kind: 'text', variant: 'heading', text: 'The rest' },
];
const kindsFor = (style: string) => ({
  ...ALL_KINDS,
  style,
  blocks:
    style === 'signboard' ? [...LEAD, ...ALL_KINDS.blocks] : ALL_KINDS.blocks,
});
/** Where a style's column is the slot itself at 1440: drawn equal to the check, not merely within. */
const EXACT: Partial<Record<string, readonly (keyof typeof DRAWN)[]>> = {
  journal: ['text', 'quote', 'photo', 'gallery', 'video', 'services', 'events'],
  signboard: [
    'text',
    'quote',
    'photo',
    'gallery',
    'video',
    'services',
    'events',
  ],
  tiles: ['text', 'quote', 'photo', 'gallery', 'video', 'services', 'events'],
};

test("every new style draws every block within the design check's slot, and exactly where its column is the slot", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { contracts } = await studioModules();
  for (const style of [
    'journal',
    'linen',
    'stage',
    'horizon',
    'signboard',
    'sprint',
    'tiles',
  ] as const)
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/dev/studio-lab?style=${style}&doc=${encodeDoc(kindsFor(style))}`,
      );
      await ready(page);
      for (const [kind, selector] of Object.entries(DRAWN) as [
        keyof typeof DRAWN,
        string,
      ][]) {
        // The widest one drawn (a gallery's photos may differ), among those shown at this width.
        const drawn = await page
          .locator(`.studio-block[data-kind="${kind}"] ${selector}`)
          .evaluateAll((els) =>
            Math.max(
              ...els
                .filter((el) => (el as HTMLElement).offsetParent !== null)
                .map((el) => el.getBoundingClientRect().width),
            ),
          );
        expect(drawn, `${style} ${kind} at ${width} is shown`).toBeGreaterThan(
          0,
        );
        const slot = contracts.studioSlotWidth(style, kind, width) as number;
        expect(
          Math.round(drawn),
          `${style} ${kind} at ${width}`,
        ).toBeLessThanOrEqual(slot + 1);
        // At 1440 the column is the slot itself: equal, not merely within.
        if (width === 1440 && EXACT[style]?.includes(kind))
          expect(
            Math.abs(Math.round(drawn) - slot),
            `${style} ${kind} at ${width}: ${drawn} vs ${slot}`,
          ).toBeLessThanOrEqual(1);
      }
    }
});

// Narrow phones (fix round 1): every amount label fits inside its chip, unselected and selected
// (650 is wider than 500), in every new style drawn so far. The chip's own box is
// overflow: visible, so the layout probe can't see this.
for (const style of [
  'clear',
  'journal',
  'linen',
  'stage',
  'horizon',
  'signboard',
  'sprint',
  'tiles',
] as const)
  test(`${style} fits every amount label inside its chip at 320 and 360`, async ({
    page,
  }) => {
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/dev/studio-lab?style=${style}`);
      await ready(page);
      const chips = page.locator('.studio-tip .tm-amount-choice');
      const count = await chips.count();
      expect(count).toBeGreaterThan(0);
      const fits = () =>
        chips.evaluateAll((labels) =>
          labels.map((label) => {
            const span = label.querySelector(':scope > span')!;
            const cs = getComputedStyle(span);
            const inner =
              span.clientWidth -
              parseFloat(cs.paddingLeft) -
              parseFloat(cs.paddingRight);
            const range = document.createRange();
            range.selectNodeContents(span);
            const text = range.getBoundingClientRect().width;
            return { label: span.textContent, text, inner };
          }),
        );
      for (let i = 0; i < count; i += 1) {
        await chips.nth(i).click();
        // Custom moves focus to its field; the chips stay where they are.
        await settled(page);
        const now = await fits();
        for (const [j, chip] of now.entries())
          expect(
            chip.text,
            `${style} at ${width}: “${chip.label}” ${j === i ? 'selected' : 'unselected'} is ${chip.text.toFixed(1)} px in ${chip.inner.toFixed(1)}`,
          ).toBeLessThanOrEqual(chip.inner + 0.5);
      }
      // Two by two or four across, every chip stays a full target (§4.4: 44, as drawn 48). The
      // new styles' check; Clear's segments are its own (§9.2).
      if (!['signboard', 'sprint', 'tiles'].includes(style)) continue;
      const heights = await chips.evaluateAll((labels) =>
        labels.map((l) =>
          l.querySelector(':scope > span')!.getBoundingClientRect(),
        ),
      );
      for (const r of heights) {
        expect(r.height, `${style} at ${width}`).toBeGreaterThanOrEqual(44);
        expect(r.width, `${style} at ${width}`).toBeGreaterThanOrEqual(44);
      }
    }
  });

// Ruling V: the probe excuses a one-line ellipsis only where the markup opts in (data-truncate),
// and never on a name, an amount or a Tip label, so clipping there can't hide.
test('the layout probe still catches a truncated name, amount or Tip label', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  for (const [selector, what] of [
    ['.studio-name', 'name'],
    ['.studio-tip .tm-amount-choice > span', 'amount'],
    ['.studio-tip .composer-submit', 'Tip'],
  ] as const) {
    await page.goto('/dev/studio-lab?style=journal');
    await ready(page);
    expect(await geometryProblems(page), `${what} before`).toEqual([]);
    await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        el.setAttribute('data-truncate', '');
        Object.assign((el as HTMLElement).style, {
          width: '24px',
          minWidth: '0',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        });
      });
    expect(
      (await geometryProblems(page)).length,
      `a clipped ${what} is reported`,
    ).toBeGreaterThan(0);
  }
  // A marked link handle that truncates is a drawn ellipsis, not a fault.
  await page.goto('/dev/studio-lab?style=linen');
  await ready(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(
    page.locator('.studio-link__sub[data-truncate]').first(),
  ).toBeAttached();
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

// Stage and Horizon (PR 2d, §9.4, §9.9, §4.2, §13): the identity over a full-bleed cover photo.
const OVER = ['stage', 'horizon'] as const;

/**
 * Every text run over the photo: its colour, and the scrim's black at the run's top (the least it
 * gets), read from the scrim's own computed gradient and box; plus the run's contrast in white
 * over that scrim over a white photo, the worst case (Horizon's glass adds its own layers).
 */
const overPhotoText = (page: Page) =>
  page.evaluate(() => {
    const words = document.querySelector('.studio-scrim')!;
    const scrim = getComputedStyle(words, '::before');
    const box = words.getBoundingClientRect();
    const height = parseFloat(scrim.height);
    const bottom = box.bottom;
    // Chrome may give a `to top` gradient back as the same gradient drawn downwards.
    const up = /^linear-gradient\(to top/.test(scrim.backgroundImage);
    const stops = [
      ...scrim.backgroundImage.matchAll(
        /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)(?: ([\d.]+)%)?/g,
      ),
    ].map((m, i, all) => ({
      a: m[4] === undefined ? 1 : Number(m[4]),
      at:
        m[5] !== undefined ? Number(m[5]) / 100 : i === all.length - 1 ? 1 : 0,
    }));
    /** The scrim's black at `rise`: the share of its height above its foot. */
    const alphaAt = (rise: number) => {
      const f = up ? rise : 1 - rise;
      for (let i = 1; i < stops.length; i += 1)
        if (f <= stops[i]!.at)
          return (
            stops[i - 1]!.a +
            ((stops[i]!.a - stops[i - 1]!.a) * (f - stops[i - 1]!.at)) /
              (stops[i]!.at - stops[i - 1]!.at || 1)
          );
      return stops.at(-1)!.a;
    };
    const lum = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const runs: {
      text: string;
      colour: string;
      black: number;
      ratio: number;
      large: boolean;
      name: boolean;
    }[] = [];
    const walker = document.createTreeWalker(words, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      const text = n.textContent!.trim();
      if (!text || el.closest('.studio-pro, .studio-hero__tip')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.height < 1) continue;
      const cs = getComputedStyle(el);
      const black = alphaAt((bottom - r.top) / height);
      // White over (scrim over a white photo), then the glass if the run sits on it.
      let grey = 255 * (1 - black);
      if (el.closest('.studio-hero__links'))
        grey = (grey * (1 - 0.32) + 10 * 0.32) * (1 - 0.14) + 255 * 0.14;
      const ratio = 1.05 / (lum(grey) + 0.05);
      const size = parseFloat(cs.fontSize);
      runs.push({
        text: text.slice(0, 24),
        colour: cs.color,
        black,
        ratio,
        large: size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700),
        name: Boolean(el.closest('.studio-name')),
      });
    }
    return { gradient: scrim.backgroundImage, runs };
  });

for (const style of OVER)
  test(`${style}: text over a photo sits on its scrim, white only`, async ({
    page,
  }) => {
    for (const [width, name] of [
      [390, 'Kemi Adeyinka'],
      [320, 'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀'],
      [1440, 'Kemi Adeyinka'],
      [1440, 'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí Ọ̀ṣúnfúnmiláyọ̀'],
    ] as const)
      for (const mode of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `/dev/studio-lab?style=${style}&mode=${mode}&name=${encodeURIComponent(name)}`,
        );
        await ready(page);
        await settled(page);
        const { gradient, runs } = await overPhotoText(page);
        const at = `${width} ${mode} ${name}`;
        // The name's backing is the scrim gradient, over the photo.
        expect(gradient, at).toMatch(/^linear-gradient\(/);
        await expect(
          page.locator('.studio-hero[data-cover="photo"] .studio-cover__photo'),
        ).toBeVisible();
        // At least the name and one line of meta or label.
        expect(runs.length, at).toBeGreaterThanOrEqual(2);
        for (const run of runs) {
          expect(run.colour, `${at}: “${run.text}”`).toBe('rgb(255, 255, 255)');
          expect(
            run.black,
            `${at}: “${run.text}” on ${run.black.toFixed(3)} black`,
          ).toBeGreaterThanOrEqual(run.name ? 0.42 : 0.55);
          expect(
            run.ratio,
            `${at}: “${run.text}” ${run.ratio.toFixed(2)}:1 over a white photo`,
          ).toBeGreaterThanOrEqual(run.large ? 3 : 4.5);
        }
      }
  });

test('Stage and Horizon fall back to their gradient treatment when the cover is not a photo', async ({
  page,
}) => {
  // Many page loads in one test: the burn-in runs it beside others.
  test.setTimeout(120_000);
  for (const style of OVER)
    for (const yours of ['design', 'automatic', 'animated'] as const)
      for (const mode of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.goto(
          `/dev/studio-lab?style=${style}&yours=${yours}&mode=${mode}`,
        );
        await ready(page);
        const at = `${style} ${yours} ${mode}`;
        await expect(
          page.locator('.studio-hero[data-cover="gradient"]'),
          at,
        ).toHaveCount(1);
        await expect(
          page.locator(
            '.studio-cover__photo, .studio .profile-cover, .studio-scrim',
          ),
          at,
        ).toHaveCount(0);
        // The check says why: the style needs a photo.
        await expect(
          page.locator('.studio-lab-check [data-rule="cover-photo"]'),
          at,
        ).toHaveCount(1);
        // The words are in the page's own colours, readable.
        expect(await contrastProblems(page), at).toEqual([]);
        expect(await geometryProblems(page), at).toEqual([]);
      }
  // Gradient and plain chosen outright: clean too, light and dark, phone and desktop.
  for (const style of OVER)
    for (const cover of ['gradient', 'plain'] as const)
      for (const mode of ['light', 'dark'] as const)
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `/dev/studio-lab?style=${style}&cover=${cover}&mode=${mode}`,
          );
          await ready(page);
          const at = `${style} ${cover} ${mode} ${width}`;
          await expect(
            page.locator(`.studio-hero[data-cover="${cover}"]`),
            at,
          ).toHaveCount(1);
          expect(await contrastProblems(page), at).toEqual([]);
          expect(await geometryProblems(page), at).toEqual([]);
          if (width === 390) await expectAccessible(page);
        }
});

test(`Horizon's "Send a tip" scrolls to and focuses the Tip area; "See links" scrolls to the links and is absent without links`, async ({
  page,
}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/dev/studio-lab?style=horizon');
    await ready(page);
    const inView = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top < window.innerHeight;
      });
    expect(await inView('.studio-tip'), `${width}`).toBe(false);
    await page.getByRole('link', { name: 'Send a tip' }).click();
    await expect(page.locator('#studio-tip')).toBeFocused();
    await expect.poll(() => inView('.studio-tip'), `${width}`).toBe(true);
    // From there the keyboard moves on into the amounts.
    await page.keyboard.press('Tab');
    await expect(
      page.locator('.studio-tip .tm-amount-choice input').first(),
    ).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('link', { name: 'See links' }).click();
    await expect.poll(() => inView('#studio-links'), `${width}`).toBe(true);
    // The glass link's focus ring is white (§4.4).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('link', { name: 'See links' }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(
      await page
        .getByRole('link', { name: 'See links' })
        .evaluate((el) => getComputedStyle(el).outlineColor),
    ).toBe('rgb(255, 255, 255)');
  }
  await page.goto('/dev/studio-lab?style=horizon&links=0');
  await ready(page);
  await expect(page.getByRole('link', { name: 'Send a tip' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'See links' })).toHaveCount(0);
  await expect(page.locator('#studio-links')).toHaveCount(0);
});

test('a small cover photo is never upscaled', async ({ page }) => {
  const width = (src: string) => Number(/wide-(\d+)$/.exec(src)?.[1]);
  for (const style of OVER)
    for (const viewport of [390, 1440]) {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto(`/dev/studio-lab?style=${style}&yours=small`);
      await ready(page);
      const photo = page.locator('.studio-cover__photo');
      await expect(photo).toHaveJSProperty('complete', true);
      const chosen = await photo.evaluate(
        (i) => (i as HTMLImageElement).currentSrc,
      );
      expect(
        width(chosen),
        `${style} at ${viewport}: ${chosen}`,
      ).toBeLessThanOrEqual(640);
      // Cropped by the style: cover, the upper third; and fetched first.
      expect(
        await photo.evaluate((i) => {
          const cs = getComputedStyle(i);
          return [
            cs.objectFit,
            cs.objectPosition,
            i.getAttribute('fetchpriority'),
          ];
        }),
      ).toEqual(['cover', '50% 33%', 'high']);
    }
  // A large photo is offered at its sharpest for a wide screen.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=stage');
  await ready(page);
  await expect(page.locator('.studio-cover__photo')).toHaveJSProperty(
    'complete',
    true,
  );
  expect(
    width(
      await page
        .locator('.studio-cover__photo')
        .evaluate((i) => (i as HTMLImageElement).currentSrc),
    ),
  ).toBe(1440);
});

test('the Stage glow appears only in dark mode', async ({ page }) => {
  const glow = () =>
    page
      .locator('.studio-hero')
      .evaluate((el) => getComputedStyle(el, '::before').backgroundImage);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=stage&mode=dark');
  await ready(page);
  expect(await glow()).toMatch(/^radial-gradient\(/);
  await page.goto('/dev/studio-lab?style=stage&mode=light');
  await ready(page);
  expect(await glow()).toBe('none');
  // Auto follows the browser, with no script.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/dev/studio-lab?style=stage&mode=auto');
  await ready(page);
  expect(await glow()).toMatch(/^radial-gradient\(/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(glow).toBe('none');
  // Behind a photo only: a gradient cover has none.
  await page.goto('/dev/studio-lab?style=stage&mode=dark&cover=gradient');
  await ready(page);
  expect(
    await page
      .locator('.studio-hero')
      .evaluate((el) => getComputedStyle(el, '::before').display),
  ).toBe('none');
  // Horizon has none.
  await page.goto('/dev/studio-lab?style=horizon&mode=dark');
  await ready(page);
  expect(
    await page
      .locator('.studio-hero')
      .evaluate((el) => getComputedStyle(el, '::before').backgroundImage),
  ).toBe('none');
});

test("Stage's desktop puts the bio, the Tip and the handle in a 400 px card beside the main column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=stage');
  await ready(page);
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
  const [lead, links, name] = await Promise.all([
    box('.studio-lead'),
    box('.studio-links'),
    box('.studio-name'),
  ]);
  expect(Math.round(lead.right - lead.left)).toBe(400);
  expect(Math.round(links.left - lead.right)).toBe(80);
  expect(Math.round(links.right - links.left)).toBeLessThanOrEqual(720);
  expect(Math.round(name.left)).toBe(Math.round(lead.left));
  await expect(page.locator('.studio-lead .studio-bio')).toBeVisible();
  await expect(page.locator('.studio-lead .studio-lead__handle')).toHaveText(
    '@studiolab',
  );
  await expect(page.locator('.studio-hero .studio-meta__handle')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.studio-lead .studio-lead__handle')).toBeHidden();
  await expect(page.locator('.studio-hero .studio-meta__handle')).toBeVisible();
});

// Fix round 1 (PR 2d review): §4.4 never by colour alone; WCAG 2.4.7 focus visible; §9.9 the
// right column holds the first block when there are no links.
test('Stage and Horizon mark the selected amount by more than colour', async ({
  page,
}) => {
  for (const style of OVER) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dev/studio-lab?style=${style}`);
    await ready(page);
    await page.locator('.studio-tip .tm-amount-choice').nth(1).click();
    const cue = (n: number) =>
      page
        .locator('.studio-tip .tm-amount-choice > span')
        .nth(n)
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          const dot = getComputedStyle(el, '::after');
          return {
            weight: cs.fontWeight,
            dot:
              dot.display !== 'none' &&
              dot.content !== 'none' &&
              parseFloat(dot.width) > 0,
          };
        });
    const [selected, other] = [await cue(1), await cue(0)];
    expect(
      selected.weight !== other.weight || selected.dot !== other.dot,
      `${style}: ${JSON.stringify({ selected, other })}`,
    ).toBe(true);
  }
});

test(`Horizon's Tip area shows its focus when reached from "Send a tip" by keyboard`, async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/studio-lab?style=horizon');
  await ready(page);
  await page.getByRole('link', { name: 'Send a tip' }).focus();
  await page.keyboard.press('Enter');
  const tip = page.locator('#studio-tip');
  await expect(tip).toBeFocused();
  const ring = await tip.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: parseFloat(cs.outlineWidth),
      shadow: cs.boxShadow,
    };
  });
  expect(
    (ring.style !== 'none' && ring.width >= 2) || ring.shadow !== 'none',
    JSON.stringify(ring),
  ).toBe(true);
});

test('Horizon on desktop with no links puts the first block beside the Tip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=horizon&links=0');
  await ready(page);
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top };
      });
  const [lead, first, second] = await Promise.all([
    box('.studio-lead'),
    box('.studio-section >> nth=0'),
    box('.studio-section >> nth=1'),
  ]);
  expect(Math.round(first.left - lead.right)).toBe(80);
  expect(Math.round(first.right - first.left)).toBe(520);
  expect(Math.abs(first.top - lead.top)).toBeLessThanOrEqual(1);
  // The rest follow below, split as before.
  expect(Math.round(second.left)).toBe(Math.round(lead.left));
  expect(await geometryProblems(page)).toEqual([]);
  // With links, the links hold that place.
  await page.goto('/dev/studio-lab?style=horizon');
  await ready(page);
  const links = await box('.studio-links');
  expect(Math.round(links.left - lead.right)).toBe(80);
});

// Fix round 2 (controller ruling Y): Horizon's own "Send a tip" is a Tip action, so the phone's
// bar stays down while it is in view too, and shows once it and the in-page Tip have both gone.
test(`Horizon's phone bar waits until both "Send a tip" and the in-page Tip are out of view`, async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/studio-lab?style=horizon');
  await ready(page);
  const form = page.locator('form[data-skin]');
  const bar = page.locator('.tip-bar');
  await expect(form).toHaveAttribute('data-bar', 'hidden');
  await expect(page.getByRole('link', { name: 'Send a tip' })).toBeInViewport();
  await expect(bar).toBeHidden();
  // Past the hero, with the in-page Tip on screen: still down.
  await page.locator('.studio-tip .composer-submit').scrollIntoViewIfNeeded();
  await expect(form).toHaveAttribute('data-bar', 'hidden');
  // Past both: up.
  await page.locator('.studio-foot').scrollIntoViewIfNeeded();
  await expect(form).toHaveAttribute('data-bar', 'shown');
  await expect(bar).toBeVisible();
  // Back to the top: down again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(form).toHaveAttribute('data-bar', 'hidden');
  // Other styles keep §8's rule: Stage's bar shows as soon as its in-page Tip leaves.
  await page.goto('/dev/studio-lab?style=stage');
  await ready(page);
  await page.locator('.studio-foot').scrollIntoViewIfNeeded();
  await expect(page.locator('form[data-skin]')).toHaveAttribute(
    'data-bar',
    'shown',
  );
});

// Signboard, Sprint and Tiles (PR 2e, spec §9.5, §9.6, §9.7, §9.10).

/** The name's size, line height and line count, and whether any word was split over two lines. */
const nameLines = (page: Page) =>
  page.locator('.studio-name').evaluate((h) => {
    const cs = getComputedStyle(h);
    const range = document.createRange();
    const text = h.firstChild as Text;
    const words: string[] = [];
    let split = false;
    // Words break at spaces and after hyphens; each must sit on one line.
    const re = /[^\s-]+-?/g;
    for (let m = re.exec(text.data); m; m = re.exec(text.data)) {
      range.setStart(text, m.index);
      range.setEnd(text, m.index + m[0].length);
      const tops = new Set(
        [...range.getClientRects()].map((r) => Math.round(r.top)),
      );
      if (tops.size > 1) {
        split = true;
        words.push(m[0]);
      }
    }
    range.selectNodeContents(h);
    const lines = new Set(
      [...range.getClientRects()].map((r) => Math.round(r.top)),
    ).size;
    return {
      size: parseFloat(cs.fontSize),
      lineHeight: parseFloat(cs.lineHeight),
      wrap: cs.textWrap || cs.getPropertyValue('text-wrap-style'),
      lines,
      split,
      words,
    };
  });

test('Sprint steps a three-line name from 64 to 52 px with line height 1.2', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=sprint');
  await ready(page);
  const short = await nameLines(page);
  expect(short.size).toBe(64);
  expect(short.lineHeight).toBe(76);
  const name = 'Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀';
  await page.goto(
    `/dev/studio-lab?style=sprint&name=${encodeURIComponent(name)}`,
  );
  await ready(page);
  const long = await nameLines(page);
  expect(long.size).toBe(52);
  expect(long.lineHeight).toBeCloseTo(52 * 1.2, 1);
  expect(long.lines).toBe(3);
  expect(long.split, long.words.join(', ')).toBe(false);
  // Uppercase, Anton, nothing pokes out.
  const h = page.locator('.studio-name');
  await expect(h).toHaveCSS('text-transform', 'uppercase');
  expect(await geometryProblems(page)).toEqual([]);
});

test('Signboard steps names over 18 letters from 30 to 24 px and balances two lines; the avatar keeps its overlap', async ({
  page,
}) => {
  const overlap = () =>
    page.evaluate(() => {
      const band = document
        .querySelector('.studio-band')!
        .getBoundingClientRect();
      const avatar = document
        .querySelector('.studio-identity .studio-avatar')!
        .getBoundingClientRect();
      return band.bottom - avatar.top;
    });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=signboard');
  await ready(page);
  const short = await nameLines(page);
  expect(short.size).toBe(30);
  // The name sits in the accent band; the avatar box straddles the band's 2 px ink edge.
  await expect(page.locator('.studio-band .studio-name')).toHaveCount(1);
  const before = await overlap();
  expect(before).toBeGreaterThanOrEqual(40);
  const name = 'Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí';
  await page.goto(
    `/dev/studio-lab?style=signboard&name=${encodeURIComponent(name)}`,
  );
  await ready(page);
  const long = await nameLines(page);
  expect(long.size).toBe(24);
  expect(long.lines).toBe(2);
  expect(long.wrap).toMatch(/balance/);
  expect(long.split, long.words.join(', ')).toBe(false);
  // The band grows with the name; the avatar's overlap is the same.
  expect(Math.abs((await overlap()) - before)).toBeLessThanOrEqual(1);
  expect(await geometryProblems(page)).toEqual([]);
});

test('every other style steps a name down about 80% before a third line, with no mid-word break', async ({
  page,
}) => {
  // Many page loads in one test: the burn-in runs it beside others.
  test.setTimeout(120_000);
  for (const style of ['tiles', 'signboard', 'sprint'] as const)
    for (const name of LONG_NAMES)
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `/dev/studio-lab?style=${style}&name=${encodeURIComponent(name)}`,
        );
        await ready(page);
        const got = await nameLines(page);
        expect(got.split, `${style} ${name} at ${width}: ${got.words}`).toBe(
          false,
        );
        expect(
          await geometryProblems(page),
          `${style} ${name} at ${width}`,
        ).toEqual([]);
      }
  // Tiles' long name is about 80% of its 28 px.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(
    `/dev/studio-lab?style=tiles&name=${encodeURIComponent(LONG_NAMES[0]!)}`,
  );
  await ready(page);
  const tiles = await nameLines(page);
  expect(tiles.size / 28).toBeGreaterThanOrEqual(0.75);
  expect(tiles.size / 28).toBeLessThanOrEqual(0.85);
});

test('Signboard and Sprint offer no gradient', async ({ page }) => {
  const { contracts } = await studioModules();
  await page.setViewportSize({ width: 390, height: 900 });
  for (const style of ['signboard', 'sprint'] as const) {
    expect(contracts.STUDIO_STYLES[style].covers).not.toContain('gradient');
    // Asked for one, the page draws "Your cover" (the lab's photo), never a gradient.
    await page.goto(`/dev/studio-lab?style=${style}&cover=gradient`);
    await ready(page);
    await expect(
      page.locator('.studio-cover[data-cover="gradient"]'),
    ).toHaveCount(0);
    await expect(page.locator('.studio-cover[data-cover="photo"]')).toHaveCount(
      1,
    );
  }
});

test('the Tip tile is first and two wide in Tiles, with "Send a tip" and "Goes to {first name}"', async ({
  page,
}) => {
  for (const [width, columns] of [
    [390, 2],
    [1440, 4],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev/studio-lab?style=tiles');
    await ready(page);
    const grid = page.locator('.studio-grid');
    const tile = grid.locator('.studio-tip');
    await expect(
      tile.getByRole('heading', { name: 'Send a tip' }),
    ).toBeVisible();
    await expect(tile.getByText('Goes to Kemi', { exact: true })).toBeVisible();
    const layout = await grid.evaluate((g) => {
      const cs = getComputedStyle(g);
      const tip = g.querySelector('.studio-tip')!;
      const tiles = [...g.querySelectorAll('.studio-link, .studio-tip')];
      return {
        columns: cs.gridTemplateColumns.split(' ').length,
        span: getComputedStyle(tip).gridColumnStart,
        first: tiles[0] === tip,
        tipTop: tip.getBoundingClientRect().top,
        linkTops: [...g.querySelectorAll('.studio-link')].map(
          (l) => l.getBoundingClientRect().top,
        ),
        tipWidth: tip.getBoundingClientRect().width,
        // The grid's own columns: its box less its padding (the phone's gutters).
        gridWidth:
          g.clientWidth -
          parseFloat(cs.paddingLeft) -
          parseFloat(cs.paddingRight),
      };
    });
    expect(layout.columns, `${width}`).toBe(columns);
    expect(layout.span, `${width}`).toBe('span 2');
    expect(layout.first, `${width}`).toBe(true);
    // Two of the grid's columns: half the phone's grid (all of it, gap 12) or half the desktop's.
    const two = width === 390 ? layout.gridWidth : (layout.gridWidth - 16) / 2;
    expect(Math.abs(layout.tipWidth - two), `${width}`).toBeLessThanOrEqual(1);
    for (const top of layout.linkTops)
      expect(top, `${width}: links follow the Tip tile`).toBeGreaterThanOrEqual(
        layout.tipTop,
      );
    // Inside the tile the Tip is inverted (accLabel fill, acc text); the phone bar's is acc.
    if (width === 390) {
      const fill = (selector: string) =>
        page.locator(selector).evaluate((el) => {
          const cs = getComputedStyle(el);
          return [cs.backgroundColor, cs.color];
        });
      const [inTile, inTileText] = await fill(
        '.studio-tip .composer-action .composer-submit',
      );
      const [bar, barText] = await fill('.tip-bar__button');
      expect(inTile).toBe(barText);
      expect(inTileText).toBe(bar);
    }
  }
});

test("Signboard's Tip has the one hard shadow 3px 3px 0", async ({ page }) => {
  for (const mode of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/dev/studio-lab?style=signboard&mode=${mode}`);
    await ready(page);
    const { contracts } = await studioModules();
    const shadow = contracts.STUDIO_STYLES.signboard.neutrals[mode]
      .shadow as string;
    const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(shadow.slice(i, i + 2), 16)).join(', ')})`;
    const tip = page.locator('.studio-tip .composer-submit');
    await expect(tip).toHaveCSS('box-shadow', `${rgb} 3px 3px 0px 0px`);
    // Nothing else on the page casts a shadow (the phone bar repeats the same Tip).
    const others = await page
      .locator('.studio')
      .evaluate((root) =>
        [...root.querySelectorAll('*')]
          .filter(
            (el) =>
              getComputedStyle(el).boxShadow !== 'none' &&
              !el.matches('.studio-tip .composer-submit, .tip-bar__button'),
          )
          .map((el) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}`),
      );
    expect(others, mode).toEqual([]);
  }
});

test('Signboard, Sprint and Tiles mark the selected amount by more than colour', async ({
  page,
}) => {
  for (const style of ['signboard', 'sprint', 'tiles'] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dev/studio-lab?style=${style}`);
    await ready(page);
    await page.locator('.studio-tip .tm-amount-choice').nth(1).click();
    const cue = (n: number) =>
      page
        .locator('.studio-tip .tm-amount-choice > span')
        .nth(n)
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          const mark = getComputedStyle(el, '::after');
          return {
            weight: Number(cs.fontWeight),
            mark:
              mark.display !== 'none' &&
              mark.content !== 'none' &&
              parseFloat(mark.width) > 0,
          };
        });
    const [selected, other] = [await cue(1), await cue(0)];
    expect(
      selected.weight - other.weight >= 100 || (selected.mark && !other.mark),
      `${style}: ${JSON.stringify({ selected, other })}`,
    ).toBe(true);
  }
});

test('Signboard and Tiles draw focus 3 px out; inside the Tip tile the ring is accLabel', async ({
  page,
}) => {
  const { contracts } = await studioModules();
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  for (const style of ['signboard', 'tiles', 'sprint'] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dev/studio-lab?style=${style}`);
    await ready(page);
    const tokens = contracts.studioTokens(style, null).light;
    // A link, from the keyboard.
    await page.locator('.studio-link').first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    // Polled: the site eases outlines in, so a single read can land mid-way.
    const ring = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement!);
        return [
          cs.outlineStyle,
          cs.outlineWidth,
          cs.outlineOffset,
          cs.outlineColor,
        ];
      });
    await expect
      .poll(ring, { message: style })
      .toEqual([
        'solid',
        '2px',
        style === 'sprint' ? '2px' : '3px',
        rgb(tokens.accText as string),
      ]);
    // The in-page Tip, from the keyboard.
    await page.locator('.studio-tip .composer-submit').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const tip = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement!);
        return [cs.outlineStyle, cs.outlineColor];
      });
    await expect
      .poll(tip, { message: style })
      .toEqual([
        'solid',
        rgb((style === 'tiles' ? tokens.tileFocus : tokens.accText) as string),
      ]);
  }
});
