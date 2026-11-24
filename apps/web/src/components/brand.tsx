import Link from 'next/link';

/**
 * The TipMe logo (the owner's files, public/brand; lib/wordmark.ts), drawn by CSS from two masks so
 * each page can colour its two parts: `--logo-ink` (black by default, white on dark grounds) and
 * `--logo-accent` (TipMe purple). `label` names it for screen readers; pass null where something
 * around it already does (the home link).
 */
export function Wordmark({
  className,
  label = 'TipMe',
}: {
  className?: string;
  label?: string | null;
}) {
  return (
    <span
      className={className ? `wordmark ${className}` : 'wordmark'}
      {...(label
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true })}
    />
  );
}

/** The heart of two figures alone, drawn as the wordmark is (`.brandmark`). Decoration. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={className ? `brandmark ${className}` : 'brandmark'}
      aria-hidden="true"
    />
  );
}

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="TipMe home">
      <Wordmark className="brand__mark" label={null} />
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
