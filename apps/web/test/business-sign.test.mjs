import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsQR from 'jsqr';
import {
  SIGN_FORMATS,
  SIGN_STYLES,
  codeUrl,
  drawLocationSign,
  drawStaffBadge,
  printedLink,
} from '../src/lib/business-sign.ts';
import { isScannableStyle, QR_STYLES } from '../src/lib/qr-render.ts';

// PR B8: the printed location sign and staff badge. Every drawn code must scan to the exact URL.

globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};

/** A canvas that records what is drawn: the code's pixels and every line of text. */
function fakeCanvas() {
  const drawn = { images: [], texts: [], fonts: [], pictures: [], clips: 0 };
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    clip() {
      drawn.clips += 1;
    },
    drawImage(image, x, y, w, h) {
      drawn.pictures.push({ image, x, y, w, h });
    },
    putImageData(image, x, y) {
      drawn.images.push({ image, x, y });
    },
    fillText(text) {
      drawn.texts.push(text);
      drawn.fonts.push(ctx.font);
    },
    measureText(text) {
      const size = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10);
      return { width: text.length * size * 0.55 };
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, drawn };
}

const ORIGIN = 'http://127.0.0.1:3120';
const SIGN_PATH = '/b/yellow-chilli/vi?src=qr';
const BADGE_PATH = '/b/yellow-chilli/vi/tobi?src=qr';

test('the code URL is the web origin plus the path; the printed link drops the scheme and the tag', () => {
  assert.equal(codeUrl(ORIGIN, SIGN_PATH), `${ORIGIN}${SIGN_PATH}`);
  assert.equal(
    printedLink('https://usetipme.xyz/b/yellow-chilli/vi?src=qr'),
    'usetipme.xyz/b/yellow-chilli/vi',
  );
});

test('only the scannable TipMe black and purple styles are offered', () => {
  assert.deepEqual(
    SIGN_STYLES.map((style) => style.id),
    ['night', 'purple'],
  );
  for (const style of SIGN_STYLES) {
    assert.ok(QR_STYLES.includes(style));
    assert.equal(isScannableStyle(style), true);
  }
});

test('the formats: an A5 sign, an A6 table tent and an 85 × 55 mm badge', () => {
  assert.deepEqual(
    SIGN_FORMATS.map((format) => [format.id, format.size]),
    [
      ['sign', 'Prints on A5'],
      ['tent', 'Prints on A6'],
      ['badge', 'Prints 85 × 55 mm'],
    ],
  );
});

test('the drawn sign decodes to the location URL with src=qr, in every style', () => {
  for (const style of SIGN_STYLES) {
    const { canvas, drawn } = fakeCanvas();
    const url = codeUrl(ORIGIN, SIGN_PATH);
    drawLocationSign(canvas, {
      url,
      business: 'The Yellow Chilli',
      location: 'Victoria Island',
      style,
      width: 1000,
    });
    assert.equal(canvas.width, 1000);
    assert.equal(canvas.height, Math.round((1000 * 210) / 148));
    assert.equal(drawn.images.length, 1);
    const { image } = drawn.images[0];
    const decoded = jsQR(image.data, image.width, image.height);
    assert.equal(decoded?.data, url, `${style.id} decodes`);
    assert.equal(
      new URL(decoded.data).pathname + new URL(decoded.data).search,
      SIGN_PATH,
    );
    // The code fits inside the card.
    assert.ok(
      drawn.images[0].x >= 0 && drawn.images[0].x + image.width <= 1000,
    );
    for (const text of [
      'T',
      'The Yellow Chilli',
      'Victoria Island',
      'Scan to tip our team',
      '127.0.0.1:3120/b/yellow-chilli/vi',
    ])
      assert.ok(drawn.texts.includes(text), `${style.id} shows ${text}`);
  }
});

test('the drawn badge decodes to the staff URL, with the name and "at {business}"', () => {
  for (const style of SIGN_STYLES) {
    const { canvas, drawn } = fakeCanvas();
    const url = codeUrl(ORIGIN, BADGE_PATH);
    drawStaffBadge(canvas, {
      url,
      name: 'Tobi',
      business: 'The Yellow Chilli',
      style,
      width: 1020,
    });
    assert.equal(canvas.height, Math.round((1020 * 55) / 85));
    const { image } = drawn.images[0];
    assert.equal(jsQR(image.data, image.width, image.height)?.data, url);
    assert.ok(image.width <= canvas.height, 'the code fits the badge');
    assert.ok(drawn.texts.includes('Tobi'));
    assert.ok(drawn.texts.includes('at The Yellow Chilli'));
  }
});

test('a long business name is shrunk or cut to fit, never drawn past the card', () => {
  const { canvas, drawn } = fakeCanvas();
  const business =
    'The Very Long Name Of A Restaurant And Bar And Grill In Lagos';
  drawLocationSign(canvas, {
    url: codeUrl(ORIGIN, SIGN_PATH),
    business,
    location: 'Victoria Island',
    style: SIGN_STYLES[0],
    width: 600,
  });
  const index = drawn.texts.findIndex(
    (text) => text === business || text.endsWith('…'),
  );
  assert.ok(index >= 0);
  const size = Number(/(\d+)px/.exec(drawn.fonts[index])[1]);
  assert.ok(drawn.texts[index].length * size * 0.55 <= 600 * 0.86 + 1);
});

test('a business with a logo shows the logo in the tile, clipped to it, instead of the initial', () => {
  const url = codeUrl(ORIGIN, SIGN_PATH);
  const logo = { width: 512, height: 512 };
  const { canvas, drawn } = fakeCanvas();
  drawLocationSign(canvas, {
    url,
    business: 'The Yellow Chilli',
    location: 'Victoria Island',
    style: SIGN_STYLES[0],
    width: 1000,
    logo,
  });
  assert.equal(drawn.pictures.length, 1);
  const tile = Math.round(1000 * 0.13);
  assert.deepEqual(drawn.pictures[0], {
    image: logo,
    x: 500 - tile / 2,
    y: Math.round(Math.round((1000 * 210) / 148) * 0.08),
    w: tile,
    h: tile,
  });
  assert.equal(drawn.clips, 1, 'the logo is clipped to the rounded tile');
  assert.equal(drawn.texts.includes('T'), false, 'no initial');
  // The code is the same with or without a logo.
  const { image } = drawn.images[0];
  assert.equal(jsQR(image.data, image.width, image.height)?.data, url);

  // Without a logo (or when it failed to load), the initial as before.
  const plain = fakeCanvas();
  drawLocationSign(plain.canvas, {
    url,
    business: 'The Yellow Chilli',
    location: 'Victoria Island',
    style: SIGN_STYLES[0],
    width: 1000,
    logo: null,
  });
  assert.equal(plain.drawn.pictures.length, 0);
  assert.ok(plain.drawn.texts.includes('T'));
  assert.deepEqual(plain.drawn.images[0].image.data, image.data);
});

test('a logo that is not square is cropped to cover the tile, not squashed', () => {
  const { canvas, drawn } = fakeCanvas();
  drawLocationSign(canvas, {
    url: codeUrl(ORIGIN, SIGN_PATH),
    business: 'The Yellow Chilli',
    location: 'Victoria Island',
    style: SIGN_STYLES[0],
    width: 1000,
    logo: { width: 400, height: 200 },
  });
  const tile = Math.round(1000 * 0.13);
  const { w, h, x } = drawn.pictures[0];
  assert.equal(h, tile);
  assert.equal(w, tile * 2);
  assert.equal(x, 500 - tile);
});
