import { expect, test, type Page } from '@playwright/test';
import { NIGERIAN_NAME, startStack, type Stack } from './profile-fixtures';

// The owner's fix of 17 Nov 2026: DM Serif Display and Manrope lack ₦, Yoruba ẹ ọ ṣ and Hausa
// ɓ ɗ ƙ ƴ, so the browser drew those letters from a system font and a name mixed fonts letter by
// letter. Inter is now the backup straight after each face, and every amount is set in Inter.
// The fonts are read from the browser itself (DevTools' platform fonts for a node), so a system
// font (DejaVu on Linux, Arial or Helvetica on a Mac) drawing any letter fails the test.

type Used = { familyName: string; isCustomFont: boolean; glyphCount: number };

/** The fonts that actually drew the text of the first match, after every web font has settled. */
async function fontsDrawing(page: Page, selector: string): Promise<Used[]> {
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  await cdp.detach();
  return fonts.map(({ familyName, isCustomFont, glyphCount }) => ({
    familyName,
    isCustomFont,
    glyphCount,
  }));
}

/** Family names without the instance a variable font reports ("Manrope ExtraLight" is Manrope). */
const names = (fonts: Used[]) =>
  fonts
    .map((f) =>
      f.familyName.replace(
        / (Thin|ExtraLight|Light|Regular|Medium|SemiBold|Bold|ExtraBold|Black)$/,
        '',
      ),
    )
    .sort();

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack('live');
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const tag of ['', ' @mobile'])
  test(`a Yoruba and Hausa name and its ₦ amounts are drawn in the page's own fonts, never a system font${tag}`, async ({
    page,
  }) => {
    await page.goto(`${stack.origin}/@eniola`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText(NIGERIAN_NAME);

    // The name: DM Serif Display for the letters it has, Inter for Ẹ ọ Ɗ ɗ. No system font.
    const name = await fontsDrawing(page, 'h1');
    expect(
      name.every((f) => f.isCustomFont),
      JSON.stringify(name),
    ).toBe(true);
    expect(names(name)).toEqual(['DM Serif Display', 'Inter']);
    // Ẹ, ọ, Ɗ and ɗ: exactly four letters come from Inter.
    expect(name.find((f) => f.familyName.startsWith('Inter'))?.glyphCount).toBe(
      4,
    );

    // The role, in Manrope, takes ṣ and ẹ from Inter too.
    const role = await fontsDrawing(page, '.profile-role');
    expect(
      role.every((f) => f.isCustomFont),
      JSON.stringify(role),
    ).toBe(true);
    expect(names(role)).toEqual(['Inter', 'Manrope']);

    // An amount key: every glyph (₦ and the figures) in Inter, with tabular figures.
    const key = page.locator('.amount-options .money span').first();
    await expect(key).toHaveText('₦1,000');
    expect(await fontsDrawing(page, '.amount-options .money span')).toEqual([
      { familyName: 'Inter', isCustomFont: true, glyphCount: 6 },
    ]);
    const style = await key.evaluate((el) => {
      const s = getComputedStyle(el);
      return { family: s.fontFamily, numeric: s.fontVariantNumeric };
    });
    expect(style.family).toMatch(/^"?interMoney"?,/);
    expect(style.numeric).toContain('tabular-nums');

    // The typed amount uses the same face; its hint is the darker #6e6a63 (4.59:1 on the recessed field).
    const other = page.getByLabel(/^Other amount/);
    expect(
      await other.evaluate((el) => getComputedStyle(el).fontFamily),
    ).toMatch(/^"?interMoney"?,/);
    expect(
      await other.evaluate((el) => getComputedStyle(el, '::placeholder').color),
    ).toBe('rgb(110, 106, 99)');

    // Both Inter faces loaded: the money face, and the backup only because this page needs it.
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/"/g, ''))
        .sort(),
    );
    expect(loaded).toEqual(
      expect.arrayContaining(['interGlyphs', 'interMoney']),
    );
  });

test('both Inter faces share one file, downloaded once and never preloaded', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (/\/Inter_400_700\.[^/]*\.woff2$/.test(request.url()))
      requested.push(request.url());
  });
  await page.goto(`${stack.origin}/@eniola`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    NIGERIAN_NAME,
  );
  await page.evaluate(() => document.fonts.ready);
  expect(requested).toHaveLength(1);
  // Not preloaded: the name's own face and the interface face are; Inter waits until needed.
  await expect(
    page.locator('link[rel="preload"][href*="Inter_400_700"]'),
  ).toHaveCount(0);
  const backup = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.family.replace(/"/g, '') === 'interGlyphs')
      .map((f) => f.unicodeRange),
  );
  expect(backup).toEqual([
    'U+20A6, U+300-36F, U+180-24F, U+250-2AF, U+1E00-1EFF',
  ]);
});
