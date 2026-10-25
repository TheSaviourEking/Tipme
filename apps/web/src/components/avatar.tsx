'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

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
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (failed)
    return (
      <span
        className={`${className ?? ''} avatar--initials`}
        aria-label={`Portrait unavailable for ${name}`}
      >
        {initialsFor(name)}
      </span>
    );

  return (
    <Image
      className={className}
      src={src}
      alt={`Portrait of ${name}, a fictional demo recipient`}
      width={width}
      height={height}
      sizes={sizes}
      priority={priority}
      onError={() => setFailed(true)}
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
