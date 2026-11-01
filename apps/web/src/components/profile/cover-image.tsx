'use client';

import Image from 'next/image';
import { useState, type ReactNode } from 'react';

/**
 * The picture of a cover, and nothing else on the client: it only has to notice that the file
 * failed to load and show the automatic look instead. The look is drawn on the server and
 * passed in, so none of the catalogue code is shipped to the browser.
 */
export function CoverImage({
  src,
  unoptimized,
  priority = false,
  fallback,
}: {
  src: string;
  unoptimized: boolean;
  priority?: boolean;
  fallback: ReactNode;
}) {
  // Remembering which source failed resets the fallback when src changes, without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <>{fallback}</>;
  return (
    <Image
      src={src}
      alt=""
      fill
      sizes="100vw"
      // Bundled artwork is already tuned; a high quality avoids a second visible lossy pass.
      quality={85}
      unoptimized={unoptimized}
      style={{ objectFit: 'cover', objectPosition: 'center' }}
      // Next 16 deprecates Image `priority`; the first cover loads eagerly at high priority.
      {...(priority
        ? { loading: 'eager' as const, fetchPriority: 'high' as const }
        : {})}
      onError={() => setFailedSrc(src)}
    />
  );
}
