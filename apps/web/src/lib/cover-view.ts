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
const RIPPLES = [2, 4, 6, 8, 10];
// Hearts climbing from lower left to upper right, clear of the photo and the tipping panel.
const RISING: [number, number, number][] = [
  [340, 230, 0.6],
  [450, 190, 0.95],
  [590, 135, 1.45],
  [760, 85, 2.2],
];
/** A heart drawn about its centre (x, y is the middle of its bounding box). */
const placed = (x: number, y: number, scale: number) =>
  `translate(${x} ${y}) scale(${scale}) translate(-727 -50)`;
const BIG = placed(560, 140, 3.6);

/** The shapes of a heart design, drawn in `tone` over the cover's base colour. */
export function heartShapes(
  design: string,
  tone: string,
  line: string = tone,
): HeartShape[] {
  switch (design) {
    case 'scattered':
      return SCATTER.map((transform) => ({ d: HEART, transform, fill: tone }));
    case 'outline':
      return SCATTER.map((transform) => ({
        d: HEART,
        transform,
        stroke: line,
        strokeWidth: 2,
      }));
    case 'large':
    case 'dark':
      return [{ d: HEART, transform: BIG, fill: tone }];
    case 'ripple':
      return RIPPLES.map((scale) => ({
        d: HEART,
        transform: placed(560, 146, scale),
        stroke: line,
        // Every ring is about 2 px wide on screen whatever its scale.
        strokeWidth: +(2 / scale).toFixed(3),
      }));
    case 'rising':
      return RISING.map(([x, y, scale]) => ({
        d: HEART,
        transform: placed(x, y, scale),
        fill: tone,
      }));
    default:
      return [];
  }
}

export interface HeartsView {
  kind: 'hearts';
  design: string;
  base: string;
  tone: string;
  line: string;
  shapes: HeartShape[];
  layout: HeartLayout;
}

export type CoverView =
  { kind: 'image'; src: string; unoptimized: boolean } | HeartsView;

const NEUTRAL =
  COVER_COLOURS.find((c) => c.id === 'neutral') ?? COVER_COLOURS[0];

function hearts(design: string, colourId: string | undefined): HeartsView {
  const layout = HEART_LAYOUTS[design]!;
  const { colours } = COVER_DESIGNS.find((d) => d.id === design) ?? {
    colours: true,
  };
  const picked = colourId
    ? COVER_COLOURS.find((c) => c.id === colourId)
    : undefined;
  const { base, tone, line } = !colours
    ? COVER_DARK
    : (picked ?? NEUTRAL ?? COVER_DARK);
  return {
    kind: 'hearts',
    design,
    base,
    tone,
    line,
    shapes: heartShapes(design, tone, line),
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

/** The automatic look, for when a cover's picture can't be shown. */
export const fallbackHearts = (): HeartsView => hearts('scattered', 'neutral');
