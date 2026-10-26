'use client';

import Image from 'next/image';
import { useState } from 'react';

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function AvatarImage({
  src,
  name,
  width,
  height,
  sizes,
  className,
  priority = false,
}: {
  src: string;
  name: string;
  width: number;
  height: number;
  sizes: string;
  className?: string;
  priority?: boolean;
}) {
  // Remembering which source failed resets the fallback when src changes, without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src)
    return (
      <span
        className={`${className ?? ''} avatar--initials`}
        role="img"
        aria-label={`Portrait unavailable for ${name}`}
      >
        {initialsFor(name)}
      </span>
    );

  return (
    <Image
      className={className}
      src={src}
      alt={`Photo of ${name}`}
      width={width}
      height={height}
      sizes={sizes}
      // Next 16 deprecates Image `priority`; an above-the-fold hero loads eagerly at high priority.
      {...(priority
        ? { loading: 'eager' as const, fetchPriority: 'high' as const }
        : {})}
      onError={() => setFailedSrc(src)}
    />
  );
}

export function Avatar({
  src,
  name,
  size = 64,
}: {
  src: string;
  name: string;
  size?: number;
}) {
  return (
    <AvatarImage
      className="avatar"
      src={src}
      name={name}
      width={size}
      height={size}
      sizes={`${size}px`}
    />
  );
}
