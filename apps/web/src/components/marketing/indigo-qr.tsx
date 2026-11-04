import Image from 'next/image';
import { INDIGO_CARD_STYLE, qrMatrix } from '@/lib/qr-render';

// The ScreenHome board's example QR: navy dot modules and ring-shaped corner eyes on a white
// rounded card, over the Indigo Grid cover. It encodes the site, not a person, and still scans
// (INDIGO_CARD_STYLE is checked by apps/web/test/qr-styles.test.mjs).
const CODE = (() => {
  const { size, isDark } = qrMatrix('https://usetipme.xyz');
  const inEye = (row: number, col: number) =>
    (row < 7 && col < 7) ||
    (row < 7 && col >= size - 7) ||
    (row >= size - 7 && col < 7);
  // Each dot is a zero-length round-capped stroke: a few bytes a module.
  let dots = '';
  for (let row = 0; row < size; row += 1)
    for (let col = 0; col < size; col += 1)
      if (isDark(row, col) && !inEye(row, col))
        dots += `M${col + 0.5} ${row + 0.5}h0`;
  const eyes = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const;
  return { size, dots, eyes };
})();

export function IndigoQr({
  className,
  sizes,
}: {
  className?: string;
  sizes: string;
}) {
  const { size, dots, eyes } = CODE;
  const { dark, light } = INDIGO_CARD_STYLE;
  return (
    <div className={`indigo-qr ${className ?? ''}`} aria-hidden="true">
      <Image
        src="/covers/indigo.webp"
        alt=""
        fill
        sizes={sizes}
        className="indigo-qr__cover"
      />
      <svg
        className="indigo-qr__code"
        viewBox={`-3 -3 ${size + 6} ${size + 6}`}
      >
        <rect
          x="-3"
          y="-3"
          width={size + 6}
          height={size + 6}
          rx="2.2"
          fill={light}
        />
        <path
          d={dots}
          stroke={dark}
          strokeWidth="0.88"
          strokeLinecap="round"
          fill="none"
        />
        {eyes.map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width="6"
              height="6"
              rx="1.9"
              fill="none"
              stroke={dark}
              strokeWidth="1"
            />
            <rect
              x={x + 2}
              y={y + 2}
              width="3"
              height="3"
              rx="0.9"
              fill={dark}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
