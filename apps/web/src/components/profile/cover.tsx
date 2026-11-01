'use client';

import Image from 'next/image';
import { useId, useState } from 'react';
import type { ResolvedCover } from '@tipme/contracts';
import { API_ORIGIN } from '@/lib/avatar-source';
import { FALLBACK_COVER, coverView } from '@/lib/cover-view';

/**
 * A page's cover. Decorative, so the picture has an empty `alt`. The frame holds its shape
 * before anything loads (no layout shift), and a picture that fails shows the automatic look
 * rather than a hole. Nothing moves here; a crossfade belongs to the editors.
 */
export function ProfileCover({
  cover,
  priority = false,
}: {
  cover: ResolvedCover;
  /** Only for the first cover on a page, the one that may be the largest paint. */
  priority?: boolean;
}) {
  // Remembering which cover failed resets the fallback when the cover changes, without an effect.
  const [failed, setFailed] = useState<string | null>(null);
  const hatchId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const view = coverView(cover, API_ORIGIN);
  const shown =
    view.kind === 'image' && failed === view.src
      ? coverView(FALLBACK_COVER, API_ORIGIN)
      : view;

  return (
    <div
      className="profile-cover"
      data-profile-cover={shown.kind === 'image' ? 'image' : shown.design}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '2240 / 600',
        overflow: 'hidden',
        background: shown.kind === 'hearts' ? shown.base : '#e6e4dc',
      }}
    >
      {shown.kind === 'image' ? (
        <Image
          src={shown.src}
          alt=""
          fill
          sizes="100vw"
          style={{ objectFit: 'cover', objectPosition: 'center' }}
          unoptimized={shown.unoptimized}
          // Next 16 deprecates Image `priority`; the first cover loads eagerly at high priority.
          {...(priority
            ? { loading: 'eager' as const, fetchPriority: 'high' as const }
            : {})}
          onError={() => setFailed(shown.src)}
        />
      ) : (
        <svg
          aria-hidden="true"
          focusable="false"
          width="100%"
          height="100%"
          viewBox={`0 ${(shown.layout.height - 300) / 2} 1120 300`}
          preserveAspectRatio="xMidYMid slice"
          style={{ display: 'block' }}
        >
          {shown.layout.tile ? (
            <>
              <defs>
                <pattern
                  id={hatchId}
                  width={shown.layout.tile.width}
                  height={shown.layout.tile.height}
                  patternUnits="userSpaceOnUse"
                >
                  <g>
                    {shown.shapes.map((s) => (
                      <path
                        key={s.transform}
                        d={s.d}
                        transform={s.transform}
                        fill={s.fill ?? 'none'}
                        {...(s.stroke
                          ? { stroke: s.stroke, strokeWidth: s.strokeWidth }
                          : {})}
                      />
                    ))}
                  </g>
                </pattern>
              </defs>
              <rect
                x="0"
                y="-20"
                width="1120"
                height="340"
                fill={`url(#${hatchId})`}
              />
            </>
          ) : (
            shown.shapes.map((s) => (
              <path
                key={s.transform}
                d={s.d}
                transform={s.transform}
                fill={s.fill ?? 'none'}
                {...(s.stroke
                  ? { stroke: s.stroke, strokeWidth: s.strokeWidth }
                  : {})}
              />
            ))
          )}
        </svg>
      )}
    </div>
  );
}
