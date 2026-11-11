import type { HTMLAttributes } from 'react';

/** The pill itself: the spark and the word. Shared by the plain and the explained badge. */
export function ProMark({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={className ? `tm-pro-badge ${className}` : 'tm-pro-badge'}
      {...props}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="tm-pro-badge__spark"
      >
        <path d="M8 0c.5 4.2 3.8 7.5 8 8-4.2.5-7.5 3.8-8 8-.5-4.2-3.8-7.5-8-8 4.2-.5 7.5-3.8 8-8Z" />
      </svg>
      Pro
    </span>
  );
}
