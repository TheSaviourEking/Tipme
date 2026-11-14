/**
 * The Page Studio layout model (plan Task 4): how wide each cell is at each screen width. The
 * design check uses it, and the renderer's grid CSS (Task 5) must use the same STUDIO_GRID
 * numbers; a source test there keeps the two from drifting.
 *
 * Below 768px every row is one column (left column first). From 768 to 1023px, 1-1-1 rows are two
 * columns and the rest keep their split. From 1024px the tip block sits in a right rail and rows
 * fill the main column beside it. Rows with a background get an inner inset.
 */
import {
  columnCount,
  type StudioBlock,
  type StudioColumns,
  type StudioDocument,
  type StudioRow,
} from './studio-document.js';

export const STUDIO_BREAKPOINTS = [320, 390, 768, 1024, 1440] as const;

export const STUDIO_GRID = {
  columns: 12,
  tablet: 768,
  desktop: 1024,
  /** The page stops growing here; wider screens get margins. */
  maxWidth: 1440,
  padding: { phone: 16, tablet: 24, desktop: 24 },
  gap: { phone: 16, tablet: 20, desktop: 24 },
  /** The tip block's rail at ≥1024px, and the gap between it and the rows. */
  rail: 340,
  railGap: 32,
  /** Inner inset of a row with a card, colour or photo background. */
  inset: { phone: 16, wide: 24 },
  /** Gap between gallery tiles. */
  tileGap: 8,
} as const;

/** Spans out of 12, per cell, on a desktop screen. */
export const STUDIO_SPANS: Record<StudioColumns, readonly number[]> = {
  '1': [12],
  '1-1': [6, 6],
  '2-1': [8, 4],
  '1-2': [4, 8],
  '1-1-1': [4, 4, 4],
};

/** The narrowest cell each block kind and variant can take without looking broken. */
export const BLOCK_MIN_WIDTH: Record<
  `${StudioBlock['kind']}:${string}`,
  number
> = {
  'text:heading': 140,
  'text:lead': 180,
  'text:paragraph': 160,
  'photo:square': 96,
  'photo:circle': 96,
  'photo:tall': 96,
  'photo:wide': 160,
  'gallery:grid': 200,
  'gallery:strip': 240,
  'gallery:mosaic': 240,
  'video:still': 200,
  'services:list': 160,
  'services:cards': 220,
  'events:list': 160,
  'events:cards': 220,
  'links:buttons': 180,
  'links:icons': 140,
  'quote:plain': 160,
  'quote:band': 180,
  'about:plain': 160,
  'supporters:names': 140,
};

/** Width of the column the rows sit in. */
export function mainWidth(viewport: number): number {
  const g = STUDIO_GRID;
  if (viewport < g.tablet) return viewport - 2 * g.padding.phone;
  if (viewport < g.desktop) return viewport - 2 * g.padding.tablet;
  return (
    Math.min(viewport, g.maxWidth) - 2 * g.padding.desktop - g.rail - g.railGap
  );
}

/** Spans per cell at this width, after reflow. */
export function spansAt(
  columns: StudioColumns,
  viewport: number,
): readonly number[] {
  const n = columnCount(columns);
  if (viewport < STUDIO_GRID.tablet) return Array.from({ length: n }, () => 12);
  if (viewport < STUDIO_GRID.desktop && columns === '1-1-1') return [6, 6, 6];
  return STUDIO_SPANS[columns];
}

/** Width inside a row, after its background inset. */
export function rowInner(
  row: Pick<StudioRow, 'background'>,
  viewport: number,
): number {
  const inset =
    row.background === 'page'
      ? 0
      : viewport < STUDIO_GRID.tablet
        ? STUDIO_GRID.inset.phone
        : STUDIO_GRID.inset.wide;
  return mainWidth(viewport) - 2 * inset;
}

const gapAt = (viewport: number) =>
  viewport < STUDIO_GRID.tablet
    ? STUDIO_GRID.gap.phone
    : viewport < STUDIO_GRID.desktop
      ? STUDIO_GRID.gap.tablet
      : STUDIO_GRID.gap.desktop;

/** CSS px of one cell. */
export function cellWidthAt(
  row: Pick<StudioRow, 'background' | 'columns'>,
  cell: number,
  viewport: number,
): number {
  const span = spansAt(row.columns, viewport)[cell] ?? 12;
  const gap = gapAt(viewport);
  const inner = rowInner(row, viewport);
  const column =
    (inner - (STUDIO_GRID.columns - 1) * gap) / STUDIO_GRID.columns;
  return Math.round((span * column + (span - 1) * gap) * 100) / 100;
}

/** Every cell's width at this screen width, keyed `rowId:cellIndex`. */
export function cellWidths(
  doc: Pick<StudioDocument, 'rows'>,
  viewport: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of doc.rows)
    row.cells.forEach(
      (_, i) => (out[`${row.id}:${i}`] = cellWidthAt(row, i, viewport)),
    );
  return out;
}

/** The blocks in a cell named `rowId:cellIndex`. */
export function blocksIn(
  doc: Pick<StudioDocument, 'rows'>,
  cell: string,
): StudioBlock[] {
  const [rowId, index] = cell.split(':');
  return doc.rows.find((r) => r.id === rowId)?.cells[Number(index)] ?? [];
}

/** Gallery tiles across a cell: 3 when the cell is at least 480px, else 2. */
export function tilesAcross(cellWidth: number): number {
  return cellWidth >= 480 ? 3 : 2;
}

/** Width of one square gallery tile (the first mosaic tile is two tiles and a gap). */
export function tileWidth(
  cellWidth: number,
  variant: 'grid' | 'strip' | 'mosaic',
  first: boolean,
): number {
  const across =
    variant === 'strip'
      ? Math.max(2, tilesAcross(cellWidth) + 1)
      : tilesAcross(cellWidth);
  const tile = (cellWidth - (across - 1) * STUDIO_GRID.tileGap) / across;
  return variant === 'mosaic' && first ? 2 * tile + STUDIO_GRID.tileGap : tile;
}
