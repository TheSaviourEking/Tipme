// The position-and-zoom step before a photo, logo or cover is saved. A view is the crop's centre,
// as a fraction of the image (0–1 across and down), and a zoom of 1 or more, where 1 is the largest
// crop of the frame's shape that fits the image. Every function returns a view whose crop lies
// wholly inside the image, so the frame is always fully covered and the saved image has no edges.

export type Size = { width: number; height: number };
export type CropView = { x: number; y: number; zoom: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export const initialView = (): CropView => ({ x: 0.5, y: 0.5, zoom: 1 });

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const safeZoom = (zoom: number) =>
  Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;

/** The crop's size in image pixels, for a frame of this width ÷ height. */
function cropSize(image: Size, aspect: number, zoom: number): Size {
  const width = Math.min(image.width, image.height * aspect) / safeZoom(zoom);
  return { width, height: width / aspect };
}

/** The same view, moved and zoomed only as far as keeps the crop inside the image. */
export function clampView(
  image: Size,
  aspect: number,
  view: CropView,
): CropView {
  const zoom = safeZoom(view.zoom);
  if (image.width <= 0 || image.height <= 0) return { x: 0.5, y: 0.5, zoom };
  const crop = cropSize(image, aspect, zoom);
  const halfX = crop.width / 2 / image.width;
  const halfY = crop.height / 2 / image.height;
  const x = Number.isFinite(view.x) ? view.x : 0.5;
  const y = Number.isFinite(view.y) ? view.y : 0.5;
  return {
    x: clamp(x, halfX, 1 - halfX),
    y: clamp(y, halfY, 1 - halfY),
    zoom,
  };
}

/** The part of the image the frame shows, in image pixels. */
export function cropRect(image: Size, aspect: number, view: CropView): Rect {
  if (image.width <= 0 || image.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  const safe = clampView(image, aspect, view);
  const crop = cropSize(image, aspect, safe.zoom);
  return {
    x: safe.x * image.width - crop.width / 2,
    y: safe.y * image.height - crop.height / 2,
    width: crop.width,
    height: crop.height,
  };
}

/**
 * Moves the image by a share of the frame (0.1 is a tenth of its width or height). Positive moves
 * the image right or down, as a finger dragging it would, so more of its left or top shows.
 */
export function panBy(
  image: Size,
  aspect: number,
  view: CropView,
  dx: number,
  dy: number,
): CropView {
  const safe = clampView(image, aspect, view);
  if (image.width <= 0 || image.height <= 0) return safe;
  const crop = cropSize(image, aspect, safe.zoom);
  return clampView(image, aspect, {
    x: safe.x - (dx * crop.width) / image.width,
    y: safe.y - (dy * crop.height) / image.height,
    zoom: safe.zoom,
  });
}

/** Zooms around the crop's centre, then pulls the crop back inside if it now reaches past an edge. */
export function zoomTo(
  image: Size,
  aspect: number,
  view: CropView,
  zoom: number,
): CropView {
  return clampView(image, aspect, { ...view, zoom });
}

/**
 * Where the whole image sits in the frame, as percentages of the frame, so the frame shows
 * exactly the crop at any size without measuring it.
 */
export function imagePlacement(
  image: Size,
  aspect: number,
  view: CropView,
): { left: number; top: number; width: number; height: number } {
  const rect = cropRect(image, aspect, view);
  if (rect.width <= 0) return { left: 0, top: 0, width: 100, height: 100 };
  return {
    left: (-rect.x / rect.width) * 100,
    top: (-rect.y / rect.height) * 100,
    width: (image.width / rect.width) * 100,
    height: (image.height / rect.height) * 100,
  };
}

/** The saved image's size: the crop, scaled down to `max` on its longest side, never up. */
export function outputSize(crop: Size, max: number): Size {
  const scale = Math.min(1, max / Math.max(crop.width, crop.height));
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
  };
}
