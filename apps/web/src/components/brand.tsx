import Link from 'next/link';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from '@/lib/wordmark';

export { WORDMARK_PATHS, WORDMARK_VIEWBOX };

export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={WORDMARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
    >
      {WORDMARK_PATHS.map((path) => (
        <path key={path.d.slice(0, 24)} d={path.d} fill={path.fill} />
      ))}
    </svg>
  );
}

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="TipMe home">
      <Wordmark className="brand__mark" />
    </Link>
  );
}

export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={diagonal ? 'arrow-diagonal' : undefined}
    >
      <path
        d="M4 12h15m-6-6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
