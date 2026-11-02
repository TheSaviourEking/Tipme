'use client';
import { qrMatrix, renderQrPixels, type QrStyle } from './qr-render';

/** Draws the square share card: frame, "Scan to thank", the code on its light square, name, link. */
export function drawQrCard(
  canvas: HTMLCanvasElement,
  input: {
    url: string;
    label: string;
    name: string;
    style: QrStyle;
    size: number;
  },
): void {
  const { size, style } = input;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = style.frame.color;
  ctx.fillRect(0, 0, size, size);
  if (style.frame.color.toLowerCase() === '#ffffff') {
    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = size * 0.006;
    ctx.strokeRect(0, 0, size, size);
  }
  const matrix = qrMatrix(input.url);
  const scale = Math.max(2, Math.floor((size * 0.56) / (matrix.size + 8)));
  const pixels = renderQrPixels(matrix, style, { scale });
  const image = new ImageData(
    new Uint8ClampedArray(pixels.data),
    pixels.width,
    pixels.width,
  );
  const x = Math.round((size - pixels.width) / 2);
  const y = Math.round(size * 0.18);
  const pad = Math.round(size * 0.02);
  ctx.fillStyle = style.light;
  ctx.beginPath();
  ctx.roundRect(
    x - pad,
    y - pad,
    pixels.width + pad * 2,
    pixels.width + pad * 2,
    size * 0.03,
  );
  ctx.fill();
  ctx.putImageData(image, x, y);
  ctx.fillStyle = style.frameText;
  ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(size * 0.045)}px Arial, sans-serif`;
  ctx.fillText('Scan to thank', size / 2, size * 0.12);
  ctx.font = `700 ${Math.round(size * 0.06)}px Arial, sans-serif`;
  ctx.fillText(input.name, size / 2, y + pixels.width + size * 0.11);
  ctx.font = `400 ${Math.round(size * 0.038)}px Arial, sans-serif`;
  ctx.fillText(input.label, size / 2, y + pixels.width + size * 0.17);
}
