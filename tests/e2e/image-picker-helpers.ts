import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// The shared image picker (photo, logo, cover): a real button opens the file chooser, then a
// position-and-zoom step, and nothing uploads until Save. Test images are generated, never photos
// of people.

type MakeImage = (options: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => {
  jpeg(): { toBuffer(): Promise<Buffer> };
  png(): { toBuffer(): Promise<Buffer> };
};
const sharp = createRequire(resolve('apps/api/package.json'))(
  'sharp',
) as MakeImage;

/** A plain generated JPEG of this size. */
export const jpegOf = (
  width: number,
  height: number,
  background = { r: 122, g: 50, b: 249 },
) =>
  sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();

export type PickedFile = { name: string; mimeType: string; buffer: Buffer };

/** Presses the picker's button (by its words) and hands the file chooser this file. */
export async function chooseImage(
  page: Page,
  scope: Locator,
  button: string | RegExp,
  file: PickedFile,
) {
  const chooser = page.waitForEvent('filechooser');
  await scope.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles(file);
}

/** The position-and-zoom step, by its name ("Position your photo"). */
export const cropStep = (scope: Locator, what: 'photo' | 'logo' | 'cover') =>
  scope.getByRole('group', { name: `Position your ${what}` });

/** Chooses the file and saves it as it opens (centred, filling the frame). */
export async function chooseAndSave(
  page: Page,
  scope: Locator,
  button: string | RegExp,
  what: 'photo' | 'logo' | 'cover',
  file: PickedFile,
) {
  await chooseImage(page, scope, button, file);
  const step = cropStep(scope, what);
  await expect(step).toBeVisible();
  await step.getByRole('button', { name: 'Save', exact: true }).click();
}
