import {
  COVER_COLOURS,
  COVER_DARK,
  COVER_DESIGNS,
  type ResolvedCover,
} from '@tipme/contracts';

// How a resolved cover is drawn (design spec §6): a photo and the eighteen pattern designs are
// images; the six heart designs are inline SVG in the catalogue's colours, so they cost no
// request. Kept free of React so the decisions can be tested on their own.

/** The brand heart, shared by every heart design. */
const HEART =
  'M701.259 76.9553L701.236 77.167C737.151 92.0868 770.727 77.7807 769.62 56.2653C768.512 34.7487 741.619 36.1332 741.619 36.1332L741.525 36.0404C741.525 36.0404 742.479 9.12833 720.948 8.36497C699.419 7.60052 685.767 41.2835 701.259 76.9553Z';

export interface HeartShape {
  d: string;
  transform: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface HeartLayout {
  /** Height of the original artboard (all are 1120 wide); the drawing is centred in the frame. */
  height: number;
  /** A repeating tile the shapes sit in, or none when they are drawn once. */
  tile?: { width: number; height: number };
}

export const HEART_LAYOUTS: Readonly<Record<string, HeartLayout>> = {
  scattered: { height: 280, tile: { width: 280, height: 210 } },
  large: { height: 280 },
  dark: { height: 280 },
  outline: { height: 293, tile: { width: 280, height: 210 } },
  ripple: { height: 293 },
  rising: { height: 293 },
};

export const HEART_DESIGNS: readonly string[] = Object.keys(HEART_LAYOUTS);

const SCATTER = [
  'translate(-670 10) rotate(-14 733 45)',
  'translate(-540 90) rotate(18 733 45)',
];
const RIPPLES: [number, number][] = [
  [2, 1],
  [4, 0.5],
  [6, 0.33],
  [8, 0.25],
  [10, 0.2],
];
const RISING: [number, number, number][] = [
  [520, 235, 0.6],
  [640, 185, 0.95],
  [790, 130, 1.45],
  [980, 80, 2.2],
];
const BIG = 'translate(-3650 -300) scale(6)';

/** The shapes of a heart design, drawn in `tone` over the cover's base colour. */
export function heartShapes(design: string, tone: string): HeartShape[] {
  switch (design) {
    case 'scattered':
      return SCATTER.map((transform) => ({ d: HEART, transform, fill: tone }));
    case 'outline':
      return SCATTER.map((transform) => ({
        d: HEART,
        transform,
        stroke: tone,
        strokeWidth: 2,
      }));
    case 'large':
    case 'dark':
      return [{ d: HEART, transform: BIG, fill: tone }];
    case 'ripple':
      return RIPPLES.map(([scale, strokeWidth]) => ({
        d: HEART,
        transform: `translate(860 120) scale(${scale}) translate(-733 -45)`,
        stroke: tone,
        strokeWidth,
      }));
    case 'rising':
      return RISING.map(([x, y, scale]) => ({
        d: HEART,
        transform: `translate(${x} ${y}) scale(${scale}) translate(-733 -45)`,
        fill: tone,
      }));
    default:
      return [];
  }
}

export type CoverView =
  | { kind: 'image'; src: string; unoptimized: boolean }
  | {
      kind: 'hearts';
      design: string;
      base: string;
      tone: string;
      shapes: HeartShape[];
      layout: HeartLayout;
    };

/** What a page shows when its cover can't be used: the automatic look, in neutral. */
export const FALLBACK_COVER: ResolvedCover = {
  kind: 'design',
  design: 'scattered',
  colour: 'neutral',
};

const NEUTRAL =
  COVER_COLOURS.find((c) => c.id === 'neutral') ?? COVER_COLOURS[0];

function hearts(design: string, colourId: string | undefined): CoverView {
  const layout = HEART_LAYOUTS[design]!;
  const { colours } = COVER_DESIGNS.find((d) => d.id === design) ?? {
    colours: true,
  };
  const picked = colourId
    ? COVER_COLOURS.find((c) => c.id === colourId)
    : undefined;
  const { base, tone } = !colours
    ? COVER_DARK
    : (picked ?? NEUTRAL ?? COVER_DARK);
  return {
    kind: 'hearts',
    design,
    base,
    tone,
    shapes: heartShapes(design, tone),
    layout,
  };
}

/**
 * Decides how a cover is drawn. A photo path is vetted the way avatars are (`avatarSource`):
 * only the API's own cover route is ever turned into an image source. A design the catalogue
 * has dropped, or a path that isn't ours, shows the automatic look instead of breaking the page.
 */
export function coverView(cover: ResolvedCover, apiOrigin: string): CoverView {
  if (cover.kind === 'photo') {
    if (/^\/v1\/covers\/[0-9a-f-]+\/\d+\.webp$/.test(cover.path))
      return {
        kind: 'image',
        src: `${apiOrigin}${cover.path}`,
        // Uploads come from the API at their final size, as avatars do.
        unoptimized: true,
      };
    return hearts('scattered', 'neutral');
  }
  if (HEART_DESIGNS.includes(cover.design))
    return hearts(cover.design, cover.colour);
  if (
    /^[a-z0-9-]+$/.test(cover.design) &&
    COVER_DESIGNS.some((d) => d.id === cover.design)
  )
    return {
      kind: 'image',
      src: `/covers/${cover.design}.webp`,
      unoptimized: false,
    };
  return hearts('scattered', 'neutral');
}
