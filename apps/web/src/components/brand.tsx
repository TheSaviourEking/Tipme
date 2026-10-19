import Link from 'next/link';

/** Primary brand wordmark: "tip" (black) + "me" (purple) + "♥" (superscript). */
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="TipMe home">
      <span className="brand-tip">tip</span>
      <span className="brand-me">me</span>
      <span className="brand-heart" aria-hidden="true">♥</span>
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
