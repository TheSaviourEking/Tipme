import { qrMatrix } from '@/lib/qr-render';

/** A real QR code that points at the site, not at a person; drawn once as a path of row runs. */
const EXAMPLE_QR = (() => {
  const { size, isDark } = qrMatrix('https://usetipme.xyz');
  let path = '';
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < size && isDark(row, col)) col += 1;
      path += `M${start} ${row}h${col - start}v1h-${col - start}z`;
    }
  }
  return { size, path };
})();

export function ExampleQr({ className }: { className?: string }) {
  const { size, path } = EXAMPLE_QR;
  return (
    <svg
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      aria-hidden="true"
      className={className}
      shapeRendering="crispEdges"
    >
      <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
