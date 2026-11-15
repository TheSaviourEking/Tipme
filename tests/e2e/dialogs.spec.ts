import { expect, test, type Page } from '@playwright/test';

// The owner, 6 Nov 2026: the admin's "Enter a fresh code" opened in the top-left corner. The site's
// CSS reset takes away the margin a browser centres a modal dialog with, so every pop-up dialog must
// sit in the middle of the window unless it is a sheet that places itself on purpose.

/**
 * Opens a modal <dialog> with this class on the page and returns its box and the window's: the
 * page's visible area (clientWidth), or with `fullWindow` the whole window the person sees.
 */
async function openDialog(page: Page, className: string, fullWindow = false) {
  return page.evaluate(
    async ([name, whole]) => {
      const dialog = document.createElement('dialog');
      dialog.className = name;
      dialog.innerHTML =
        '<h2>A pop-up</h2><p>Some words.</p><button>OK</button>';
      document.body.append(dialog);
      dialog.showModal();
      // Measured where it comes to rest, after any entry animation.
      await Promise.all(
        dialog.getAnimations().map((motion) => motion.finished),
      );
      const box = dialog.getBoundingClientRect();
      // A dialog is centred in the page's visible area: without a classic scrollbar (Linux CI has
      // one, 15px wide; a Mac's floats over the page), so measure against clientWidth, not innerWidth.
      const { clientWidth, clientHeight } = document.documentElement;
      return {
        left: box.left,
        right: (whole ? window.innerWidth : clientWidth) - box.right,
        top: box.top,
        bottom: clientHeight - box.bottom,
      };
    },
    [className, fullWindow] as const,
  );
}

// Classic scrollbars, which take up room, as on Linux CI. A Mac's float over the page and would hide
// a dialog centred on the page minus its scrollbar rather than on the window.
test.use({
  launchOptions: { args: ['--disable-features=OverlayScrollbar'] },
});

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// The fresh-code prompt and a modal with no class of its own, on a wide window and a phone.
for (const [className, size] of [
  ['ops-code-dialog', WIDE],
  ['ops-code-dialog', PHONE],
  ['', WIDE],
  ['', PHONE],
] as const) {
  test(`a modal dialog (${className || 'no class'}) sits in the middle at ${size.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    const { left, right, top, bottom } = await openDialog(page, className);
    expect(Math.abs(left - right)).toBeLessThan(2);
    expect(Math.abs(top - bottom)).toBeLessThan(2);
    expect(top).toBeGreaterThan(0);
  });
}

// The confirm dialog locks the page's scroll while open and keeps the scrollbar's gutter, so the
// page behind doesn't shift. On a classic scrollbar (Linux, 15px) that gutter is an empty strip at
// the right edge, and the dialog sat half of it, 7.5px, left of the middle of the window (#174).
// Measured against the whole window, which is what a person sees.
test('the confirm dialog sits in the middle of the whole window at 1440px', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await page.goto('/');
  const { left, right, top, bottom } = await openDialog(
    page,
    'confirm-dialog',
    true,
  );
  expect(Math.abs(left - right)).toBeLessThan(2);
  expect(Math.abs(top - bottom)).toBeLessThan(2);
  expect(top).toBeGreaterThan(0);
});

// Sheets place themselves and keep doing so: they rest on the bottom edge of a phone.
for (const className of ['ops-frame__sheet', 'confirm-dialog']) {
  test(`on a phone the ${className} sheet still rests on the bottom edge`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    const { bottom } = await openDialog(page, className);
    expect(Math.abs(bottom)).toBeLessThan(1);
  });
}
