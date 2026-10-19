'use client';
import {
  qrMatrix,
  renderQrPixels,
  type FrameFill,
  type QrStyle,
} from './qr-render';

function frameFill(
  ctx: CanvasRenderingContext2D,
  frame: FrameFill,
  size: number,
) {
  switch (frame.kind) {
    case 'solid':
      return frame.color;
    case 'linear': {
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, frame.from);
      g.addColorStop(1, frame.to);
      return g;
    }
    case 'radial': {
      const g = ctx.createRadialGradient(
        size * 0.3,
        size * 0.2,
        0,
        size * 0.3,
        size * 0.2,
        size * 1.1,
      );
      g.addColorStop(0, frame.inner);
      g.addColorStop(1, frame.outer);
      return g;
    }
    case 'stripes': {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 56;
      const t = tile.getContext('2d') as CanvasRenderingContext2D;
      t.fillStyle = frame.a;
      t.fillRect(0, 0, 56, 56);
      t.strokeStyle = frame.b;
      t.lineWidth = 20;
      for (let i = -56; i <= 112; i += 56) {
        t.beginPath();
        t.moveTo(i, 56);
        t.lineTo(i + 56, 0);
        t.stroke();
      }
      return ctx.createPattern(tile, 'repeat') ?? frame.a;
    }
  }
}

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
  ctx.fillStyle = frameFill(ctx, style.frame, size);
  ctx.fillRect(0, 0, size, size);
  if (
    style.frame.kind === 'solid' &&
    style.frame.color.toLowerCase() === '#ffffff'
  ) {
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
