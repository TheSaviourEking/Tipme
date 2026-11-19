import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import {
  contrastProblems,
  encodeDoc,
  geometryProblems,
  layoutSnapshot,
  settled,
  studioModules,
} from './studio-probes';

// Page Studio styles, render property tests (styles plan Task 13, PR 4b; they moved here from the
// v1 lab spec). Random v2 documents (`studioDocumentArb`: any style, accent, mode, cover and up to
// 45 blocks within the limits) are rendered by the real style renderer, through the dev-only lab, at
// every width in light and dark; each must have no sideways scroll, clipped text or overlap, and
// readable text. A failure here is a bug in a style's CSS or the renderer, never in the test: fix
// that, and add the saved counterexample to packages/contracts/test/fixtures/studio-regressions.json
// ("render"; the lab migrates a v1 document, a v2 one is read as it is).
//
// CI runs 150 documents (STUDIO_RENDER_RUNS) on a shard of their own (tag @studio-lab). The time cap
// stops the property before the test's own timeout, so it can't quietly grow past 6 minutes. Run
// with --repeat-each (CI's burn-in), each repeat takes its share of the documents with its own seed,
// so a burn-in checks the same number of documents, not five times as many.

const RUNS = Number(
  process.env.STUDIO_RENDER_RUNS ?? (process.env.CI ? 150 : 30),
);
const WIDTHS = [320, 390, 768, 1024, 1440];
const share = (runs: number) => {
  const { repeatEach } = test.info().project;
  return Math.max(1, Math.ceil(runs / Math.max(1, repeatEach)));
};
const seedFor = (seed: number) => seed + test.info().repeatEachIndex * 7919;
// Classic renders today's page (`main.profile-page`, or the standard page's own root when every
// choice is the default), so its scope is the page's <main>; every other style's root is `.studio`.
const rootOf = (doc: unknown) =>
  (doc as { style?: string }).style === 'classic' ? 'main' : '.studio';
const lab = (
  doc: unknown,
  mode: 'light' | 'dark',
  links: number,
  bio: boolean,
) =>
  `/dev/studio-lab?doc=${encodeDoc(doc)}&mode=${mode}&links=${links}&bio=${bio ? 1 : 0}`;

/** The lab's profile: its links and bio vary with the document, as a real page's do. */
const profileOf = (doc: { blocks?: unknown[] }) => ({
  links: (doc.blocks?.length ?? 0) % 9,
  bio: (doc.blocks?.length ?? 0) % 2 === 0,
});

const ready = async (page: Page) => {
  await page.locator('[data-style]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
};

test('random v2 documents render cleanly at 320–1440px, light and dark @studio-lab', async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const { arbitrary, pbt } = await studioModules();
  const { fc, studioDocumentArb } = arbitrary;
  const { seed, regressions } = pbt;
  const render = async (doc: unknown, ctx: { links: number; bio: boolean }) => {
    try {
      for (const mode of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(lab(doc, mode, ctx.links, ctx.bio));
        await ready(page);
        const root = rootOf(doc);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await geometryProblems(page, root),
            `${mode} at ${width}px`,
          ).toEqual([]);
          if (width === 320 || width === 1440)
            expect(
              await contrastProblems(page, root),
              `${mode} at ${width}px`,
            ).toEqual([]);
        }
      }
    } catch (error) {
      // The document, and what the page measured when it failed, attached to the result; CI
      // uploads both files.
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
    await render(doc, ctx.profile);
  await fc.assert(
    fc.asyncProperty(studioDocumentArb({ valid: true }), (doc: unknown) =>
      render(doc, profileOf(doc as { blocks?: unknown[] })),
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
// once locally on Linux). It can't be made to happen on demand, so this proves the two ends: it
// returns at once on a settled page, and it refuses, with the reading, when the page never reports
// the requested width.
test('settled waits for the requested width and says so when it never comes @studio-lab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=clear&example=styles-min');
  await ready(page);
  await settled(page);
  expect((await layoutSnapshot(page)).innerWidth).toBe(390);
  // Pretend Playwright had asked for another width than the page shows.
  page.viewportSize = () => ({ width: 333, height: 900 });
  await expect(settled(page, 1500)).rejects.toThrow(
    /did not settle at 333px within 1500ms; last reading: .*"innerWidth":390/,
  );
});

// Clear draws its selected amount on the segmented control's `::before` thumb, while the chip's own
// span is transparent and the track behind it is #e8e8ed-ish. A probe that only walks parent
// elements measured the track (coral 4.40:1 and green 4.41:1, false misses found in PR 4b); on the
// thumb they are 5.37:1 and 5.39:1. The probe now reads the thumb, and still fails a real miss.
test('the contrast probe reads the thumb under Clear’s selected amount, and still fails a real miss @studio-lab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  for (const accent of ['coral', 'green']) {
    await page.goto(`/dev/studio-lab?style=clear&accent=${accent}&mode=light`);
    await ready(page);
    // What the old probe measured: the track behind the thumb is the first opaque background up
    // the tree from the checked chip, and the text misses 4.5:1 on it.
    const onTrack = await page.evaluate(() => {
      const chip = document.querySelector(
        '.studio-tip .tm-amount-choice input:checked + span',
      )!;
      const track = getComputedStyle(chip.closest('.amount-options')!);
      const lum = (c: string) =>
        c
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((v) => Number(v) / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const [a, b] = [
        lum(getComputedStyle(chip).color),
        lum(track.backgroundColor),
      ].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    });
    expect(onTrack, `${accent} on the track`).toBeLessThan(4.5);
    expect(await contrastProblems(page, '.studio'), accent).toEqual([]);
  }
  // A thumb that really is too close to the text still fails: the probe is not blind to it.
  await page.addStyleTag({
    content:
      '.studio[data-style="clear"] .studio-tip .amount-options::before{background:#c9c9c9 !important}',
  });
  const problems = await contrastProblems(page, '.studio');
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toMatch(/< 4\.5/);
});

// With no amount selected Clear's thumb is `opacity: 0`, but Chromium still reports its white
// background. The probe must measure the first chip on the track, as it is drawn, not on that
// invisible thumb.
test('the contrast probe ignores an invisible thumb when no amount is selected @studio-lab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/dev/studio-lab?style=clear&mode=light');
  await ready(page);
  // Unselect every amount (the lab's form starts with one chosen).
  await page.evaluate(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>(
      '.studio-tip .tm-amount-choice input',
    ))
      input.checked = false;
  });
  const state = await page.evaluate(() => {
    const options = document.querySelector('.studio-tip .amount-options')!;
    const thumb = getComputedStyle(options, '::before');
    return { opacity: thumb.opacity, fill: thumb.backgroundColor };
  });
  // The premise: an invisible thumb that still reports a solid fill.
  expect(state.opacity).toBe('0');
  expect(state.fill).not.toMatch(/rgba\(.*, 0\)/);
  // A chip's text, set to #767676 (4.54:1 on white): a colour that
  // reads on white but not on #e8e8ed (the track) must be reported, so the probe measured the track.
  await page.addStyleTag({
    content:
      '.studio-tip .tm-amount-choice input + span{color:#767676 !important}',
  });
  const problems = await contrastProblems(page, '.studio');
  expect(problems.join('\n')).toMatch(
    /“[^”]*” [\d.]+ < 4\.5 .* on 232,232,237/,
  );
});

test('axe is clean on 20 random documents @studio-lab', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 900 });
  const { arbitrary, pbt } = await studioModules();
  const { fc, studioDocumentArb } = arbitrary;
  const { seed } = pbt;
  await fc.assert(
    fc.asyncProperty(
      studioDocumentArb({ valid: true }),
      async (doc: unknown) => {
        const { links, bio } = profileOf(doc as { blocks?: unknown[] });
        await page.goto(lab(doc, 'light', links, bio));
        await ready(page);
        await expectAccessible(page);
      },
    ),
    {
      numRuns: share(Math.min(20, RUNS)),
      seed: seedFor(seed() + 1),
      interruptAfterTimeLimit: 220_000,
    },
  );
});

test('the lab is not a page anyone can find', async ({ page }) => {
  await page.goto('/dev/studio-lab?style=clear');
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
