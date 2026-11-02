import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';

// Owner, 2 Nov 2026: a page with no chosen cover gets one of three heart designs in violet, forest,
// ocean or rose, picked by its handle. Settings must show the same result as the page, and
// nothing may be written on a cover (the name, the share button and the panel sit on the page's
// canvas or on their own opaque surface).
const BASES: Record<string, string> = {
  Violet: 'rgb(122, 50, 249)',
  Forest: 'rgb(31, 77, 58)',
  Ocean: 'rgb(29, 78, 137)',
  Rose: 'rgb(184, 61, 98)',
};
const DESIGNS: Record<string, string> = {
  scattered: 'Scattered hearts',
  large: 'One large heart',
  rising: 'Rising hearts',
};

test('a new page, its public cover and Settings all show the same automatic design and colour @mobile', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  const cover = visitor.locator('[data-profile-cover]');
  const design = (await cover.getAttribute('data-profile-cover')) ?? '';
  const background = await cover.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(Object.keys(DESIGNS)).toContain(design);
  expect(Object.values(BASES)).toContain(background);
  const colour = Object.entries(BASES).find(
    ([, rgb]) => rgb === background,
  )![0];

  await page.goto('/dashboard/settings');
  const shown = page
    .getByTestId('cover-preview')
    .locator('[data-profile-cover]');
  await expect(shown).toHaveAttribute('data-profile-cover', design);
  await expect(shown).toHaveCSS('background-color', background);
  // The chooser says it in words as well, so colour is never the only signal.
  await expect(page.getByTestId('cover-automatic-note')).toHaveText(
    `Now: ${DESIGNS[design]} in ${colour}`,
  );
  const thumb = page
    .locator('.cover-choice', { hasText: 'Let TipMe pick' })
    .locator('[data-profile-cover]');
  await expect(thumb).toHaveAttribute('data-profile-cover', design);
  await expect(thumb).toHaveCSS('background-color', background);
  await expectAccessible(page);
  await visitor.context().close();
});

test('nothing sits on the cover but the photo and the panel, and the panel is opaque @mobile', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto(`/@${handle}`);
  await page.locator('[data-profile-cover]').waitFor();
  const found = await page.evaluate(() => {
    const frame = document
      .querySelector('[data-profile-cover]')!
      .getBoundingClientRect();
    const over = (el: Element) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left < frame.right &&
        r.right > frame.left &&
        r.top < frame.bottom - 1 &&
        r.bottom > frame.top + 1
      );
    };
    const exempt = (el: Element) =>
      Boolean(el.closest('.profile-photo, [data-tip-panel]'));
    const sitting: string[] = [];
    for (const el of document.querySelectorAll(
      '.profile-page :is(h1, h2, h3, p, a, button, input, select, textarea, li, span, label)',
    )) {
      if (exempt(el)) continue;
      const own = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent!.trim() !== '',
      );
      const control = el.matches('a, button, input, select, textarea');
      if ((own || control) && over(el))
        sitting.push(`${el.tagName} ${el.textContent!.trim().slice(0, 30)}`);
    }
    const panel = document.querySelector('[data-tip-panel]');
    const card = panel?.querySelector('.appreciation-card') ?? panel;
    return {
      sitting,
      panelBackground: card ? getComputedStyle(card).backgroundColor : '',
      photoRing: getComputedStyle(document.querySelector('.profile-photo')!)
        .borderTopColor,
    };
  });
  expect(found.sitting).toEqual([]);
  // Opaque: neither transparent nor with an alpha channel.
  expect(found.panelBackground).toMatch(/^rgb\(/);
  expect(found.photoRing).toMatch(/^rgb\(/);
});
