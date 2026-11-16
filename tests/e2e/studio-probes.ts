import { deflateRawSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/**
 * The ES modules the Studio specs use, loaded at run time (Playwright loads specs as CommonJS, so
 * they can't be imported statically; the same pattern as the database helpers).
 */
export async function studioModules() {
  const [contracts, arbitrary, pbt] = await Promise.all([
    import('../../packages/contracts/dist/index.js'),
    import('../../packages/contracts/test/support/studio-arbitrary.mjs'),
    import('../../packages/contracts/test/support/pbt.mjs'),
  ]);
  return { contracts, arbitrary, pbt };
}

/** Sizes of the viewport, the frame and every row, read in the page (what `settled` and a failure's snapshot use). */
export const readLayout = () => {
  const root = document.documentElement;
  const rows = [...document.querySelectorAll('.studio-row')].map((row) => {
    const box = row.getBoundingClientRect();
    return {
      columns: row.getAttribute('data-columns'),
      bg: row.getAttribute('data-bg'),
      client: row.clientWidth,
      scroll: row.scrollWidth,
      left: Math.round(box.left),
      right: Math.round(box.right),
    };
  });
  return {
    innerWidth: window.innerWidth,
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    visualViewport: window.visualViewport?.width ?? null,
    frameClient: document.querySelector('.studio-frame')?.clientWidth ?? null,
    rows,
  };
};

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

/**
 * After a viewport change, wait until the browser has applied it and the layout has stopped
 * moving, then measure. Two frames alone were not enough: on a busy machine a measurement (fast-check
 * seed -732091363, 16 Nov 2026) saw a row 272px wide holding content 288px wide, which no single
 * layout produces, and the failure screenshot showed the previous width. So wait for `innerWidth`
 * to equal the width Playwright set (the document agreeing, less a scrollbar), then for two
 * readings in a row of the same frame and row sizes. Throws, with the last reading, if that does
 * not happen within `timeout`.
 */
export async function settled(page: Page, timeout = 10_000) {
  const want = page.viewportSize()?.width;
  const deadline = Date.now() + timeout;
  let previous = '';
  for (;;) {
    await frames(page);
    const read = await page.evaluate(readLayout);
    const applied =
      want === undefined ||
      (read.innerWidth === want &&
        read.clientWidth <= want &&
        want - read.clientWidth <= 24 &&
        (read.visualViewport === null ||
          Math.abs(read.visualViewport - want) <= 24));
    const signature = JSON.stringify([
      read.innerWidth,
      read.frameClient,
      read.rows,
    ]);
    if (applied && signature === previous) return;
    previous = signature;
    if (Date.now() > deadline)
      throw new Error(
        `Layout did not settle at ${want ?? '?'}px within ${timeout}ms; last reading: ${JSON.stringify(read)}`,
      );
  }
}

/** A failure's attachment: the viewport, the frame, and every row with the ones that overflow marked. */
export async function layoutSnapshot(page: Page) {
  const read = await page.evaluate(readLayout);
  return {
    requestedViewport: page.viewportSize(),
    ...read,
    overflowingRows: read.rows.filter((row) => row.scroll > row.client),
  };
}

/** A Studio document as the lab's `?doc=` parameter: deflate-raw, then base64url. */
export const encodeDoc = (doc: unknown) =>
  deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64url');

/**
 * Layout faults on a Studio page, as labels (empty when there are none): the page scrolls
 * sideways; an element that clips (overflow not visible) holds more than it shows; two blocks
 * overlap; or the tip rail overlaps the rows. TipMe's cover is tested on its own and skipped.
 */
export async function geometryProblems(page: Page): Promise<string[]> {
  await settled(page);
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth)
      out.push(
        `page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`,
      );
    const studio = document.querySelector('.studio');
    if (!studio) return ['no .studio on the page'];
    const label = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.classList[0] ? `.${el.classList[0]}` : ''}`;
    for (const el of studio.querySelectorAll('*')) {
      if (
        el.closest('.studio-cover') ||
        /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)
      )
        continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue; // visually hidden or empty
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        // Name the widest thing inside, so a failure says what didn't fit.
        const widest = [...el.querySelectorAll('*')].reduce<
          [Element | null, number]
        >(
          (best, child) => {
            const w = child.getBoundingClientRect().width;
            return w > best[1] ? [child, w] : best;
          },
          [null, 0],
        );
        out.push(
          `${label(el)} overflows sideways (${el.scrollWidth} > ${el.clientWidth}; widest: ${widest[0] ? label(widest[0]) : '?'} ${Math.round(widest[1])})`,
        );
      }
      if (cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1)
        out.push(
          `${label(el)} clips its content (${el.scrollHeight} > ${el.clientHeight})`,
        );
    }
    const boxes = [...studio.querySelectorAll('.studio-cell > *')].map(
      (el) => ({
        el,
        r: el.getBoundingClientRect(),
      }),
    );
    const meet = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1)
        if (meet(boxes[i]!.r, boxes[j]!.r))
          out.push(`${label(boxes[i]!.el)} overlaps ${label(boxes[j]!.el)}`);
    const rail = studio.querySelector('.studio-rail')?.getBoundingClientRect();
    for (const part of ['.studio-rows', '.studio-identity']) {
      const r = studio.querySelector(part)?.getBoundingClientRect();
      if (rail && r && r.height > 1 && meet(rail, r))
        out.push(`the tip rail overlaps ${part}`);
    }
    return out;
  });
}

/**
 * Text that fails WCAG contrast on a Studio page: each text node's computed colour against the
 * first opaque background behind it (inside `.studio-scrim`, the scrim over a white photo, its
 * worst case), at 4.5:1, or 3:1 for large text (≥24px, or ≥18.66px and bold).
 */
export async function contrastProblems(page: Page): Promise<string[]> {
  await settled(page);
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba | null => {
      const m =
        /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/.exec(
          c,
        );
      return m
        ? [
            Number(m[1]),
            Number(m[2]),
            Number(m[3]),
            m[4] === undefined ? 1 : Number(m[4]),
          ]
        : null;
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
    const background = (el: Element): Rgba | null => {
      const scrim = el.closest('.studio-scrim');
      const layers: Rgba[] = [];
      let base: Rgba = [255, 255, 255, 1];
      for (let at: Element | null = el; at; at = at.parentElement) {
        // The scrim's worst case is black at 62% over a white photo. A tag or card inside the
        // scrim has its own fill, found before this.
        if (at === scrim) {
          base = [97, 97, 97, 1];
          break;
        }
        const cs = getComputedStyle(at);
        if (cs.backgroundImage !== 'none') return null; // an image: not measurable here
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 0.999) break;
        }
      }
      let colour = base;
      for (const layer of layers.reverse()) colour = over(layer, colour);
      return colour;
    };
    const out: string[] = [];
    const studio = document.querySelector('.studio');
    if (!studio) return ['no .studio on the page'];
    const walker = document.createTreeWalker(studio, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (
        !text ||
        !el ||
        el.closest('.studio-cover, .sr-only, [aria-hidden="true"]')
      )
        continue;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (
        box.width <= 1 ||
        box.height <= 1 ||
        cs.visibility !== 'visible' ||
        Number(cs.opacity) < 0.1
      )
        continue;
      const fg = parse(cs.color);
      const bg = background(el);
      if (!fg || !bg) continue;
      const size = parseFloat(cs.fontSize);
      const large =
        size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(over(fg, bg), bg);
      if (got < need - 0.01)
        out.push(
          `“${text.slice(0, 30)}” ${got.toFixed(2)} < ${need} (${cs.color} on ${bg.slice(0, 3).join(',')})`,
        );
    }
    return out;
  });
}
