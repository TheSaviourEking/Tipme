import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsQR from 'jsqr';
import { drawQrCard } from '../src/lib/qr-card.ts';
import { styleById } from '../src/lib/qr-render.ts';

// The browser's ImageData, enough for drawQrCard.
globalThis.ImageData ??= class {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};

/** A canvas whose 2D context records every font it is given, and the code it is handed. */
function fakeCanvas() {
  const fonts = [];
  const texts = [];
  let image = null;
  const ctx = {
    set font(value) {
      fonts.push(value);
    },
    get font() {
      return fonts.at(-1);
    },
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    putImageData(data) {
      image = data;
    },
    fillText(text) {
      texts.push(text);
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, fonts, texts, image: () => image };
}

const input = {
  url: 'http://127.0.0.1:3100/@tobi?src=qr',
  label: '127.0.0.1:3100/@tobi',
  name: 'Tobi',
  style: styleById('purple'),
  size: 720,
};

test('drawQrCard letters the card in the family it is given', () => {
  const card = fakeCanvas();
  drawQrCard(card.canvas, { ...input, fontFamily: '"Manrope test"' });
  assert.equal(card.fonts.length, 3);
  for (const font of card.fonts)
    assert.ok(font.endsWith('"Manrope test", Arial, sans-serif'), font);
  assert.deepEqual(card.texts, ['Scan to thank', 'Tobi', input.label]);
});

test('without a family it is Arial, as before', () => {
  const card = fakeCanvas();
  drawQrCard(card.canvas, input);
  assert.deepEqual(card.fonts, [
    '600 32px Arial, sans-serif',
    '700 43px Arial, sans-serif',
    '400 27px Arial, sans-serif',
  ]);
});

test('the lettering never changes the code: it still reads the page link', () => {
  for (const fontFamily of [undefined, '"Manrope test"']) {
    const card = fakeCanvas();
    drawQrCard(card.canvas, { ...input, fontFamily });
    const { data, width, height } = card.image();
    assert.equal(jsQR(data, width, height)?.data, input.url);
  }
});
