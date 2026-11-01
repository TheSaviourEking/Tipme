import { useId } from 'react';
import type { ResolvedCover } from '@tipme/contracts';
import { API_ORIGIN } from '@/lib/avatar-source';
import { coverView, fallbackHearts, type HeartsView } from '@/lib/cover-view';
import { CoverImage } from './cover-image';

function HeartPaths({ shapes }: Pick<HeartsView, 'shapes'>) {
  return shapes.map((s) => (
    <path
      key={s.transform}
      d={s.d}
      transform={s.transform}
      fill={s.fill ?? 'none'}
      {...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth } : {})}
    />
  ));
}

/** A heart design, drawn inline: no request, and no script. */
function Hearts({ view }: { view: HeartsView }) {
  // Two covers on one page (an editor's choices) must not share a pattern id.
  const patternId = `cover-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const { tile, height } = view.layout;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="100%"
      height="100%"
      // Every artboard is 1120 wide; `slice` fills the frame, so a phone shows the middle.
      viewBox={`0 ${(height - 300) / 2} 1120 300`}
      preserveAspectRatio="xMidYMid slice"
      style={{ display: 'block' }}
    >
      {tile ? (
        <>
          <defs>
            <pattern
              id={patternId}
              width={tile.width}
              height={tile.height}
              patternUnits="userSpaceOnUse"
            >
              <HeartPaths shapes={view.shapes} />
            </pattern>
          </defs>
          <rect
            x="0"
            y="-20"
            width="1120"
            height="340"
            fill={`url(#${patternId})`}
          />
        </>
      ) : (
        <HeartPaths shapes={view.shapes} />
      )}
    </svg>
  );
}

/**
 * A page's cover. Decorative, so the picture has an empty `alt` and the drawing is hidden from
 * assistive technology. The frame's height comes from CSS (`.profile-cover`), so space is held
 * before anything loads. Rendered on the server: only an image's load failure needs the
 * browser (`CoverImage`). Nothing moves here; a crossfade belongs to the editors.
 */
export function ProfileCover({
  cover,
  priority = false,
}: {
  cover: ResolvedCover;
  /** Only for the first cover on a page, the one that may be the largest paint. */
  priority?: boolean;
}) {
  const view = coverView(cover, API_ORIGIN);
  return (
    <div
      className="profile-cover"
      data-profile-cover={view.kind === 'image' ? 'image' : view.design}
      style={{ background: view.kind === 'hearts' ? view.base : '#e6e4dc' }}
    >
      {view.kind === 'image' ? (
        <CoverImage
          src={view.src}
          unoptimized={view.unoptimized}
          priority={priority}
          fallback={<Hearts view={fallbackHearts()} />}
        />
      ) : (
        <Hearts view={view} />
      )}
    </div>
  );
}
