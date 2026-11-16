import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import {
  contrastProblems,
  encodeDoc,
  geometryProblems,
  layoutSnapshot,
  settled,
  studioModules,
} from './studio-probes';

// Page Studio render property tests (plan Task 6). Random pages that pass the design check are
// rendered by the real renderer, through the dev-only lab, at every width in light and dark; each
// must have no sideways scroll, clipped text or overlap, and readable text. A failure here is a bug
// in the check, the layout model or the CSS, never in the test: fix that, and add the saved
// counterexample to packages/contracts/test/fixtures/studio-regressions.json ("render").
//
// CI runs 150 pages (STUDIO_RENDER_RUNS) on a shard of their own (tag @studio-lab). The time cap
// stops the property before the test's own timeout, so it can't quietly grow past 6 minutes. Run
// with --repeat-each (CI's burn-in), each repeat takes its share of the pages with its own seed, so
// a burn-in checks the same number of pages, not five times as many.

const RUNS = Number(
  process.env.STUDIO_RENDER_RUNS ?? (process.env.CI ? 150 : 30),
);
const share = (runs: number) => {
  const { repeatEach } = test.info().project;
  return Math.max(1, Math.ceil(runs / Math.max(1, repeatEach)));
};
const seedFor = (seed: number) => seed + test.info().repeatEachIndex * 7919;
const lab = (
  doc: unknown,
  mode: 'light' | 'dark',
  links: number,
  bio: boolean,
) =>
  `/dev/studio-lab?doc=${encodeDoc(doc)}&mode=${mode}&links=${links}&bio=${bio ? 1 : 0}`;

test('random Studio pages that pass the check render cleanly at 320–1440px, light and dark @studio-lab', async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const { contracts, arbitrary, pbt } = await studioModules();
  const { fc, studioPassingDocument } = arbitrary;
  const { STUDIO_BREAKPOINTS } = contracts;
  const { seed } = pbt;
  const { regressions } = pbt;
  const render = async (
    doc: unknown,
    ctx: { profile: { links: number; bio: boolean } },
  ) => {
    try {
      for (const mode of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(lab(doc, mode, ctx.profile.links, ctx.profile.bio));
        await page.locator('.studio').waitFor();
        await page.evaluate(() => document.fonts.ready);
        for (const width of STUDIO_BREAKPOINTS) {
          await page.setViewportSize({ width, height: 900 });
          expect(await geometryProblems(page), `${mode} at ${width}px`).toEqual(
            [],
          );
          if (width === 320 || width === 1440)
            expect(
              await contrastProblems(page),
              `${mode} at ${width}px`,
            ).toEqual([]);
        }
      }
    } catch (error) {
      // The document, and what the page measured when it failed (viewport sizes, every row's
      // client and scroll width), attached to the result; CI uploads both files.
      const attach = async (name: string, data: unknown) => {
        const path = testInfo.outputPath(name);
        writeFileSync(path, JSON.stringify(data, null, 2));
        await testInfo.attach(name, { path, contentType: 'application/json' });
      };
      await attach('studio-counterexample.json', { doc, ctx });
      try {
        await attach('studio-snapshot.json', await layoutSnapshot(page));
      } catch (snapshotError) {
        await attach('studio-snapshot.json', { error: String(snapshotError) });
      }
      throw error;
    }
  };
  // Counterexamples found before replay first, every run.
  for (const { doc, ctx } of regressions('render') as {
    doc: unknown;
    ctx: { profile: { links: number; bio: boolean } };
  }[])
    await render(doc, ctx);
  await fc.assert(
    fc.asyncProperty(studioPassingDocument(), ({ doc, ctx }) =>
      render(doc, ctx),
    ),
    {
      numRuns: share(RUNS),
      seed: seedFor(seed()),
      interruptAfterTimeLimit: 330_000,
    },
  );
});

// The probes measure only a settled layout: `settled` waits for the browser to report the width
// Playwright set (a measurement that saw the previous width failed the property test once in CI, and
// once locally on Linux, as "div.studio-row overflows sideways (288 > 272)"). It can't be made to
// happen on demand, so this proves the two ends: it returns at once on a settled page, and it
// refuses, with the reading, when the page never reports the requested width.
test('settled waits for the requested width and says so when it never comes @studio-lab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?example=min');
  await page.locator('.studio').waitFor();
  await settled(page);
  expect((await layoutSnapshot(page)).innerWidth).toBe(390);
  // Pretend Playwright had asked for another width than the page shows.
  page.viewportSize = () => ({ width: 333, height: 900 });
  await expect(settled(page, 1500)).rejects.toThrow(
    /did not settle at 333px within 1500ms; last reading: .*"innerWidth":390/,
  );
});

test('axe is clean on 20 random passing pages @studio-lab', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 900 });
  const { arbitrary, pbt } = await studioModules();
  const { fc, studioPassingDocument } = arbitrary;
  const { seed } = pbt;
  await fc.assert(
    fc.asyncProperty(studioPassingDocument(), async ({ doc, ctx }) => {
      await page.goto(lab(doc, 'light', ctx.profile.links, ctx.profile.bio));
      await page.locator('.studio').waitFor();
      await expectAccessible(page);
    }),
    {
      numRuns: share(Math.min(20, RUNS)),
      seed: seedFor(seed() + 1),
      interruptAfterTimeLimit: 220_000,
    },
  );
});

test('the lab is not a page anyone can find', async ({ page }) => {
  await page.goto('/dev/studio-lab?example=min');
  await expect(page.locator('.studio')).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  );
  // A document it can't read is not found (the status stays 200: the shell is sent first).
  await page.goto('/dev/studio-lab?doc=not-a-document');
  await expect(page.getByText('We can’t find that page.')).toBeVisible();
  await expect(page.locator('.studio')).toHaveCount(0);
});
