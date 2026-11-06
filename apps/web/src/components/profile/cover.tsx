import { useId, type CSSProperties } from 'react';
import type { ResolvedCover } from '@tipme/contracts';
import { API_ORIGIN } from '@/lib/avatar-source';
import {
  coverView,
  fallbackHearts,
  type AnimatedView,
  type HeartsView,
} from '@/lib/cover-view';
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

// The brand heart's own bounds, so the layer's box is the heart.
const HEART_BOX = '684 6 88 74';
const HEART_PATH =
  'M701.259 76.9553L701.236 77.167C737.151 92.0868 770.727 77.7807 769.62 56.2653C768.512 34.7487 741.619 36.1332 741.619 36.1332L741.525 36.0404C741.525 36.0404 742.479 9.12833 720.948 8.36497C699.419 7.60052 685.767 41.2835 701.259 76.9553Z';

/**
 * An animated cover: five HTML layers over the base colour, each holding a small brand heart.
 * HTML, not SVG groups, so transform and opacity run on the compositor. Every layer's own style
 * is the settled frame, so `animation: none` (reduced motion, forced colours, print, a page that
 * left Pro) is always the right still picture. Server-rendered; `CoverFreeze` is the only script.
 */
function Animated({ view }: { view: AnimatedView }) {
  return (
    <>
      {view.layers.map((layer) => (
        <span
          key={layer.x}
          className={`cover-fx cover-fx--${view.animation}`}
          aria-hidden="true"
          style={
            {
              '--x': `${layer.x}%`,
              '--b': layer.bottom,
              '--s': layer.size,
              '--d': `${layer.delay}s`,
              color: view.tone,
            } as CSSProperties
          }
        >
          <svg
            viewBox={HEART_BOX}
            focusable="false"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d={HEART_PATH} />
          </svg>
        </span>
      ))}
    </>
  );
}

/**
 * A page's cover. Decorative, so the picture has an empty `alt` and the drawing is hidden from
 * assistive technology. The frame's height comes from CSS (`.profile-cover`), so space is held
 * before anything loads. Rendered on the server: only an image's load failure needs the
 * browser (`CoverImage`). Nothing moves unless `animate` is set and the cover is an animated one.
 */
export function ProfileCover({
  cover,
  priority = false,
  sizes,
  animate = false,
}: {
  cover: ResolvedCover;
  /** Only for the first cover on a page, the one that may be the largest paint. */
  priority?: boolean;
  /** Set when the cover is shown small (a choice in Settings), so a small file is fetched. */
  sizes?: string;
  /** Only the public page and the Settings preview animate; thumbnails and stamps stay still. */
  animate?: boolean;
}) {
  const view = coverView(cover, API_ORIGIN, animate);
  return (
    <div
      className="profile-cover"
      data-profile-cover={
        view.kind === 'image'
          ? 'image'
          : view.kind === 'animated'
            ? `animated:${view.animation}`
            : view.design
      }
      {...(view.kind === 'animated' ? { 'data-cover-play': view.play } : {})}
      style={{
        background:
          view.kind === 'hearts' || view.kind === 'animated'
            ? view.base
            : '#e6e4dc',
      }}
    >
      {view.kind === 'image' ? (
        <CoverImage
          src={view.src}
          unoptimized={view.unoptimized}
          priority={priority}
          {...(sizes ? { sizes } : {})}
          fallback={<Hearts view={fallbackHearts()} />}
        />
      ) : view.kind === 'animated' ? (
        <Animated view={view} />
      ) : (
        <Hearts view={view} />
      )}
    </div>
  );
}
