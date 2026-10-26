'use client';

import Image from 'next/image';
import { useState } from 'react';
import { API_ORIGIN, avatarSource } from '@/lib/avatar-source';

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * A page's picture: an uploaded photo (served by the API) or a demo portrait or illustration.
 * Initials stand in when there is none, or when it fails to load.
 */
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
  const picture = avatarSource(src, name, API_ORIGIN);

  if (!picture || failedSrc === src)
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
      src={picture.src}
      alt={picture.alt}
      width={width}
      height={height}
      sizes={sizes}
      // Uploaded photos come from the API at their final size; local demo files are optimised.
      unoptimized={!picture.src.startsWith('/')}
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
