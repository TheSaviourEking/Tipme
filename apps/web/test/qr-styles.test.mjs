import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsQR from 'jsqr';
import {
  contrastRatio,
  isScannableStyle,
  qrMatrix,
  QR_STYLES,
  renderQrPixels,
  styleById,
} from '../src/lib/qr-render.ts';

const url = 'http://127.0.0.1:3100/@tobi';

test('only the three free styles are drawn in the browser, with no premium flag', () => {
  assert.deepEqual(
    QR_STYLES.map((s) => s.id),
    ['purple', 'night', 'clean'],
  );
  assert.ok(QR_STYLES.every((s) => !('premium' in s)));
});

test('old sunset, glow and stripe values, and Pro design ids, show purple here', () => {
  for (const id of ['sunset', 'glow', 'stripe', 'heart', 'mosaic', ''])
    assert.equal(styleById(id).id, 'purple', id);
  assert.equal(styleById('night').id, 'night');
});

test('every style scans back to the exact page link', () => {
  const matrix = qrMatrix(url);
  for (const style of QR_STYLES) {
    assert.ok(
      contrastRatio(style.dark, style.light) >= 4.5,
      `${style.id} contrast`,
    );
    const { data, width } = renderQrPixels(matrix, style, { scale: 8 });
    const decoded = jsQR(data, width, width);
    assert.equal(decoded?.data, url, `${style.id} decodes`);
    assert.equal(isScannableStyle(style), true);
  }
});

test('every style also scans with the QR tag that counts scans (PR-009)', () => {
  const tagged = `${url}?src=qr`;
  const matrix = qrMatrix(tagged);
  for (const style of QR_STYLES) {
    const { data, width } = renderQrPixels(matrix, style, { scale: 8 });
    assert.equal(jsQR(data, width, width)?.data, tagged, `${style.id} decodes`);
  }
});

test('a low-contrast style is rejected before it could ship', () => {
  const faint = {
    ...QR_STYLES[0],
    id: 'faint',
    dark: '#c8c8c8',
    light: '#ffffff',
  };
  assert.ok(contrastRatio(faint.dark, faint.light) < 4.5);
  assert.equal(isScannableStyle(faint), false);
});

test('contrast is computed the WCAG way', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#7a32f9', '#7a32f9'), 1);
});
