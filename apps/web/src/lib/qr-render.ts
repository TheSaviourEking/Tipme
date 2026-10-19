import QRCode from 'qrcode';

/**
 * Recipient QR codes. The code itself is always dark modules on a light square with a quiet
 * zone, so every style scans; the style lives in the frame around it and in the module shape.
 * The three finder squares are always drawn solid, whatever the shape.
 */
export type FrameFill =
  | { kind: 'solid'; color: string }
  | { kind: 'linear'; from: string; to: string }
  | { kind: 'radial'; inner: string; outer: string }
  | { kind: 'stripes'; a: string; b: string };

export interface QrStyle {
  id: string;
  name: string;
  premium: boolean;
  /** Module colour and the light square behind the code: contrast must be at least 4.5:1. */
  dark: string;
  light: string;
  frame: FrameFill;
  frameText: string;
  shape: 'square' | 'rounded' | 'dot';
}

export const QR_STYLES: readonly QrStyle[] = [
  {
    id: 'purple',
    name: 'Purple',
    premium: false,
    dark: '#2b0a5c',
    light: '#ffffff',
    frame: { kind: 'solid', color: '#7a32f9' },
    frameText: '#ffffff',
    shape: 'rounded',
  },
  {
    id: 'night',
    name: 'Night',
    premium: false,
    dark: '#000000',
    light: '#ffffff',
    frame: { kind: 'solid', color: '#000000' },
    frameText: '#ffffff',
    shape: 'square',
  },
  {
    id: 'clean',
    name: 'Clean',
    premium: false,
    dark: '#000000',
    light: '#ffffff',
    frame: { kind: 'solid', color: '#ffffff' },
    frameText: '#000000',
    shape: 'square',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    premium: true,
    dark: '#3b0a75',
    light: '#ffffff',
    frame: { kind: 'linear', from: '#5b1ec4', to: '#c2185b' },
    frameText: '#ffffff',
    shape: 'dot',
  },
  {
    id: 'glow',
    name: 'Glow',
    premium: true,
    dark: '#2b0a5c',
    light: '#ffffff',
    frame: { kind: 'radial', inner: '#7a32f9', outer: '#2b0a5c' },
    frameText: '#ffffff',
    shape: 'rounded',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    premium: true,
    dark: '#000000',
    light: '#ffffff',
    frame: { kind: 'stripes', a: '#000000', b: '#511cb0' },
    frameText: '#ffffff',
    shape: 'square',
  },
];

export const styleById = (id: string): QrStyle =>
  QR_STYLES.find((style) => style.id === id) ?? (QR_STYLES[0] as QrStyle);

/** The CSS background for on-screen previews of a frame. */
export function frameCss(frame: FrameFill): string {
  switch (frame.kind) {
    case 'solid':
      return frame.color;
    case 'linear':
      return `linear-gradient(135deg, ${frame.from}, ${frame.to})`;
    case 'radial':
      return `radial-gradient(circle at 30% 20%, ${frame.inner}, ${frame.outer})`;
    case 'stripes':
      return `repeating-linear-gradient(45deg, ${frame.a} 0 14px, ${frame.b} 14px 28px)`;
  }
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG 2 contrast ratio between two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** A style may be offered only if its modules are darker than, and contrast well with, the square. */
export function isScannableStyle(style: QrStyle): boolean {
  return (
    luminance(style.dark) < luminance(style.light) &&
    contrastRatio(style.dark, style.light) >= 4.5
  );
}

export interface QrMatrix {
  size: number;
  isDark(row: number, col: number): boolean;
}

export function qrMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return {
    size: modules.size,
    isDark: (row, col) => Boolean(modules.get(row, col)),
  };
}

const inFinder = (size: number, row: number, col: number) =>
  (row < 7 && col < 7) ||
  (row < 7 && col >= size - 7) ||
  (row >= size - 7 && col < 7);

/** RGBA pixels of the code (with a 4-module quiet zone) in the style's colours and shape. */
export function renderQrPixels(
  matrix: QrMatrix,
  style: QrStyle,
  { scale, quiet = 4 }: { scale: number; quiet?: number },
): { data: Uint8ClampedArray; width: number } {
  const width = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  const [lr, lg, lb] = rgb(style.light);
  const [dr, dg, db] = rgb(style.dark);
  for (let i = 0; i < width * width; i += 1) {
    data[i * 4] = lr;
    data[i * 4 + 1] = lg;
    data[i * 4 + 2] = lb;
    data[i * 4 + 3] = 255;
  }
  const paint = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    data[i] = dr;
    data[i + 1] = dg;
    data[i + 2] = db;
  };
  for (let row = 0; row < matrix.size; row += 1)
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.isDark(row, col)) continue;
      const solid = style.shape === 'square' || inFinder(matrix.size, row, col);
      const x0 = (col + quiet) * scale;
      const y0 = (row + quiet) * scale;
      for (let dy = 0; dy < scale; dy += 1)
        for (let dx = 0; dx < scale; dx += 1) {
          const cx = dx + 0.5 - scale / 2;
          const cy = dy + 0.5 - scale / 2;
          const inside = solid
            ? true
            : style.shape === 'dot'
              ? cx * cx + cy * cy <= (scale * 0.46) ** 2
              : Math.max(Math.abs(cx), Math.abs(cy)) <= scale * 0.5 &&
                !(
                  Math.abs(cx) > scale * 0.3 &&
                  Math.abs(cy) > scale * 0.3 &&
                  (Math.abs(cx) - scale * 0.3) ** 2 +
                    (Math.abs(cy) - scale * 0.3) ** 2 >
                    (scale * 0.2) ** 2
                );
          if (inside) paint(x0 + dx, y0 + dy);
        }
    }
  return { data, width };
}
