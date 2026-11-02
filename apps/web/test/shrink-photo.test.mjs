import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COVER_SHRINK_MAX,
  fitWithin,
  shrinkPhoto,
} from '../src/lib/shrink-photo.ts';

test('a photo is scaled down to fit 1024 px on its longest side, never up', () => {
  assert.deepEqual(fitWithin(4032, 3024, 1024), { width: 1024, height: 768 });
  assert.deepEqual(fitWithin(3024, 4032, 1024), { width: 768, height: 1024 });
  assert.deepEqual(fitWithin(800, 600, 1024), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(5000, 10, 1024), { width: 1024, height: 2 });
});

/** What the browser would do, enough to see the size asked for. */
function fakeBrowser(t, width, height) {
  const canvas = {
    getContext: () => ({ drawImage() {} }),
    toBlob: (done) => done(new Blob(['small'])),
  };
  t.mock.method(globalThis, 'createImageBitmap', async () => ({
    width,
    height,
    close() {},
  }));
  t.mock.method(globalThis.document, 'createElement', () => canvas);
  return canvas;
}

test('photos still shrink to 1024 px, and covers to a size that stays sharp at 2240', async (t) => {
  globalThis.createImageBitmap ??= () => undefined;
  globalThis.document ??= { createElement: () => undefined };
  const canvas = fakeBrowser(t, 4032, 3024);
  await shrinkPhoto(new Blob(['big']));
  assert.deepEqual([canvas.width, canvas.height], [1024, 768]);
  await shrinkPhoto(new Blob(['big']), COVER_SHRINK_MAX);
  assert.deepEqual([canvas.width, canvas.height], [2560, 1920]);
  assert.ok(COVER_SHRINK_MAX >= 2240);
});
