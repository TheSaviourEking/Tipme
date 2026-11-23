import { expect, test, type Page } from '@playwright/test';
import {
  CELEBRATION_CASES,
  STYLE_IDS,
  startStack,
  studioFixtures,
  type CelebrationCase,
  type Stack,
} from './profile-fixtures';

// The "Celebrating Kemi's 10th tip" banner takes its colours from the page it sits on: Classic in
// light, dark and auto (either system scheme), today's purple or a chosen accent, Free or Pro, and
// every Studio style in each mode and cover. Ratios are computed here from the computed colours
// (axe can't judge a translucent or gradient surface), composited over whatever lies under them.
// The bug this guards: Classic dark kept today's pale lilac panel (#f1e9ff) while its text turned
// the dark palette's light purple, about 1.3:1.

/** Today's light panel and ink (tokens.css --brand-soft, --brand-ink). */
const LILAC = 'rgb(241, 233, 255)';
const TODAY_INK = 'rgb(77, 22, 168)';

interface Measured {
  text: string;
  /** The banner's own fill, resolved to rgb(). */
  fill: string;
  /** What the text is read on: the fill composited over the surfaces under it. */
  surface: string;
  colour: string;
  textRatio: number;
  /** The heart's ratio (Classic only), or null without one. */
  iconRatio: number | null;
  problems: string[];
}

/** Every visible banner on the page, measured. */
async function measure(page: Page): Promise<Measured[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const ctx = document.createElement('canvas').getContext('2d', {
      willReadFrequently: true,
    })!;
    // Any computed colour (rgb(), oklab(), color(srgb …)) to sRGB through the canvas.
    const rgba = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ];
    const lum = ([r, g, b]: Rgba) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const ratio = (a: Rgba, b: Rgba) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const show = (c: Rgba) =>
      `rgb(${c
        .slice(0, 3)
        .map((v) => Math.round(v))
        .join(', ')})`;
    return [
      ...document.querySelectorAll<HTMLElement>(
        '.profile-celebration, .studio-celebration',
      ),
    ]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const problems: string[] = [];
        // From the banner up: every translucent fill until an opaque one; an image under the
        // text can't be judged from colours, so it is a problem in itself.
        const layers: Rgba[] = [];
        let base: Rgba = [255, 255, 255, 1];
        for (let at: Element | null = el; at; at = at.parentElement) {
          const cs = getComputedStyle(at);
          if (cs.backgroundImage !== 'none') {
            problems.push(
              `an image (${cs.backgroundImage.slice(0, 40)}) under the text on ${at.className}`,
            );
            break;
          }
          const fill = rgba(cs.backgroundColor);
          if (fill[3] > 0) {
            if (fill[3] >= 0.999) {
              base = fill;
              break;
            }
            layers.push(fill);
          }
        }
        let surface = base;
        for (const layer of layers.reverse()) surface = over(layer, surface);
        const cs = getComputedStyle(el);
        const text = el.querySelector('span') ?? el;
        const colour = over(rgba(getComputedStyle(text).color), surface);
        const svg = el.querySelector('svg');
        const icon = svg
          ? over(rgba(getComputedStyle(svg).color), surface)
          : null;
        return {
          text: el.textContent?.trim() ?? '',
          fill: show(rgba(cs.backgroundColor)),
          surface: show(surface),
          colour: show(colour),
          textRatio: ratio(colour, surface),
          iconRatio: icon ? ratio(icon, surface) : null,
          problems,
        };
      });
  });
}

/** One case's checks; `dark` is the mode the page is shown in. */
function check(
  label: string,
  banners: Measured[],
  { dark, purple }: { dark: boolean; purple: boolean },
) {
  expect(banners, `${label}: one banner`).toHaveLength(1);
  const [b] = banners as [Measured];
  expect(b.text, label).toBe('Celebrating Kemi’s 10th tip');
  expect(b.problems, label).toEqual([]);
  expect(
    b.textRatio,
    `${label}: ${b.colour} on ${b.surface} is ${b.textRatio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(4.5);
  if (b.iconRatio !== null)
    expect(
      b.iconRatio,
      `${label}: the heart is ${b.iconRatio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(3);
  if (dark) {
    expect(b.fill, `${label}: the light lilac panel on a dark page`).not.toBe(
      LILAC,
    );
    expect(b.surface, `${label}: a light panel on a dark page`).not.toBe(LILAC);
  }
  // A chosen accent replaces today's purple, so its tint does too.
  if (!purple)
    expect(b.surface, `${label}: today's purple tint`).not.toBe(LILAC);
}

const isDark = (c: CelebrationCase, scheme: 'light' | 'dark') =>
  c.mode === 'dark' || (c.mode === 'auto' && scheme === 'dark');

test.describe('the celebration banner follows the page', () => {
  test.describe.configure({ mode: 'serial' });
  let stack: Stack;
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await studioFixtures();
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  test('today’s page keeps today’s lilac and ink, Free and Pro', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    for (const handle of ['sixkeys', 'celstandardpro']) {
      await page.goto(`${stack.origin}/@${handle}`);
      await page.locator('.profile-celebration').waitFor();
      const banners = await page.evaluate(() =>
        [...document.querySelectorAll('.profile-celebration')].map((el) => {
          const cs = getComputedStyle(el);
          return { fill: cs.backgroundColor, colour: cs.color };
        }),
      );
      expect(banners, handle).toEqual([{ fill: LILAC, colour: TODAY_INK }]);
      check(`/@${handle}`, await measure(page), { dark: false, purple: true });
    }
  });

  for (const style of STYLE_IDS) {
    test(`${style}: readable in every mode, cover and system scheme`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 900 });
      for (const c of CELEBRATION_CASES.filter((x) => x.style === style)) {
        // Auto follows the system scheme; light and dark ignore it, so one scheme is enough.
        for (const scheme of c.mode === 'auto'
          ? (['light', 'dark'] as const)
          : (['light'] as const)) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(`${stack.origin}/@${c.handle}`);
          await page.locator(`[data-style="${style}"]`).first().waitFor();
          check(`/@${c.handle} (${scheme} system)`, await measure(page), {
            dark: isDark(c, scheme),
            purple: c.accent === null || c.accent === undefined,
          });
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
    });
  }

  test('a Free page: Classic in dark purple, and a lapsed Pro style', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    // A lapsed Pro style shows Classic (§12.5), in whatever mode the page then renders.
    for (const handle of ['celclassicfreedark', 'cellapseddark']) {
      await page.goto(`${stack.origin}/@${handle}`);
      await page.locator('.profile-celebration').waitFor();
      const dark = (await page.locator('[data-mode="dark"]').count()) > 0;
      if (handle === 'celclassicfreedark') expect(dark, handle).toBe(true);
      check(`/@${handle}`, await measure(page), { dark, purple: true });
    }
  });
});
