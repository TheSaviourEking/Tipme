import Link from 'next/link';
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="TipMe home">
      tipme
      <span className="brand-flower" aria-hidden="true">
        ✳
      </span>
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
