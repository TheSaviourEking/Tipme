import { expect, test, type Page } from '@playwright/test';

// The owner, 6 Nov 2026: the admin's "Enter a fresh code" opened in the top-left corner. The site's
// CSS reset takes away the margin a browser centres a modal dialog with, so every pop-up dialog must
// sit in the middle of the window unless it is a sheet that places itself on purpose.

/** Opens a modal <dialog> with this class on the page and returns its box and the window's. */
async function openDialog(page: Page, className: string) {
  return page.evaluate((name) => {
    const dialog = document.createElement('dialog');
    dialog.className = name;
    dialog.innerHTML = '<h2>A pop-up</h2><p>Some words.</p><button>OK</button>';
    document.body.append(dialog);
    dialog.showModal();
    const box = dialog.getBoundingClientRect();
    return {
      left: box.left,
      right: innerWidth - box.right,
      top: box.top,
      bottom: innerHeight - box.bottom,
    };
  }, className);
}

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// The fresh-code prompt and a modal with no class of its own, on a wide window and a phone; the
// confirm dialog on a wide window (on a phone it is a bottom sheet, below).
for (const [className, size] of [
  ['ops-code-dialog', WIDE],
  ['ops-code-dialog', PHONE],
  ['', WIDE],
  ['', PHONE],
  ['confirm-dialog', WIDE],
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
