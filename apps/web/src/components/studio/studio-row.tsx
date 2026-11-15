import {
  STUDIO_GRID,
  cellWidthAt,
  mainWidth,
  type StudioRow,
} from '@tipme/contracts';
import { StudioBlockView, type StudioRenderContext } from './studio-blocks';
import { studioImageSources } from './studio-theme';

/**
 * One row on the 12-column grid. Columns come from `data-columns` and reflow by rule in studio.css
 * (one column below 768px; 1-1-1 is two columns until 1024px). A photo background always sits
 * under the scrim, so the words on it stay readable on any photo.
 */
export function StudioRowView({
  row,
  ctx,
}: {
  row: StudioRow;
  ctx: StudioRenderContext;
}) {
  const photo =
    typeof row.background === 'object'
      ? ctx.images[row.background.photo]
      : undefined;
  const bg =
    typeof row.background === 'object'
      ? photo
        ? 'photo'
        : 'page'
      : row.background;
  const inset = bg === 'page' ? 0 : STUDIO_GRID.inset.phone;
  const cells = (
    <div className="studio-grid">
      {row.cells.map((cell, c) => (
        <div className="studio-cell" key={c}>
          {cell.map((block) => (
            <StudioBlockView
              key={block.id}
              block={block}
              ctx={ctx}
              place={{
                row,
                tablet: cellWidthAt(row, c, 1023),
                desktop: cellWidthAt(row, c, STUDIO_GRID.maxWidth),
                phoneInset: 2 * (STUDIO_GRID.padding.phone + inset),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
  if (bg !== 'photo' || !photo || typeof row.background !== 'object')
    return (
      <div
        className="studio-row"
        data-columns={row.columns}
        data-spacing={row.spacing}
        data-bg={bg}
      >
        {cells}
      </div>
    );
  const { src, srcSet, width, height } = studioImageSources(photo, 'strip');
  return (
    <div
      className="studio-row"
      data-columns={row.columns}
      data-spacing={row.spacing}
      data-bg="photo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- TipMe's own renditions, already sized */}
      <img
        className="studio-row__photo"
        src={src}
        srcSet={srcSet}
        sizes={`(max-width: 1023px) 100vw, ${Math.round(mainWidth(STUDIO_GRID.maxWidth))}px`}
        width={width}
        height={height}
        alt=""
        loading={ctx.eager.has(`bg:${row.id}`) ? 'eager' : 'lazy'}
        decoding="async"
      />
      <div className="studio-scrim">{cells}</div>
    </div>
  );
}
