'use client';

import { useState } from 'react';

const initialOf = (name: string) =>
  Array.from(name.trim())[0]?.toUpperCase() ?? '';

/**
 * The square tile beside a business's name: its uploaded logo, or its initial when there is none
 * or the logo fails to load. Decorative: the name always sits next to it.
 */
export function BusinessLogoTile({
  name,
  src,
  className = 'business-header__logo',
}: {
  name: string;
  /** A ready URL (the API's, or a private blob); null for the initial. */
  src: string | null;
  className?: string;
}) {
  // Remembering which source failed resets the fallback when src changes, without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showLogo = src !== null && failedSrc !== src;
  return (
    <span
      className={`${className}${showLogo ? ` ${className}--image` : ''}`}
      aria-hidden="true"
      data-testid="business-logo-tile"
    >
      {showLogo ? (
        // Served at its final size by the API (or a private blob): the optimiser has no part in it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={44}
          height={44}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}
