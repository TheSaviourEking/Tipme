import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  cropRect,
  imagePlacement,
  initialView,
  outputSize,
  panBy,
  zoomTo,
} from '../src/lib/image-crop.ts';

// The position-and-zoom step: whatever the person does, the frame stays fully covered by the
// image, so the saved crop never has empty edges.

const SQUARE = 1;
const COVER = 1120 / 300;
const wide = { width: 4000, height: 3000 };
const tall = { width: 3000, height: 4000 };

/** True when the rectangle sits wholly inside the image. */
const inside = (image, rect) =>
  rect.x >= -1e-9 &&
  rect.y >= -1e-9 &&
  rect.x + rect.width <= image.width + 1e-9 &&
  rect.y + rect.height <= image.height + 1e-9;

test('opens centred at zoom 1, filling the frame: pressing Save at once gives the centre crop', () => {
  const view = initialView();
  assert.deepEqual(view, { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(cropRect(wide, SQUARE, view), {
    x: 500,
    y: 0,
    width: 3000,
    height: 3000,
  });
  assert.deepEqual(cropRect(tall, SQUARE, view), {
    x: 0,
    y: 500,
    width: 3000,
    height: 3000,
  });
  // A cover from a landscape photo: the full width, a centred band.
  const band = cropRect(wide, COVER, view);
  assert.equal(band.width, 4000);
  assert.ok(Math.abs(band.height - 4000 / COVER) < 1e-9);
  assert.ok(Math.abs(band.y - (3000 - band.height) / 2) < 1e-9);
});

test('zoom stays between 1 and the maximum, and zooming in shrinks the crop around its centre', () => {
  assert.equal(zoomTo(wide, SQUARE, initialView(), 0.2).zoom, MIN_ZOOM);
  assert.equal(zoomTo(wide, SQUARE, initialView(), 99).zoom, MAX_ZOOM);
  assert.equal(zoomTo(wide, SQUARE, initialView(), Number.NaN).zoom, MIN_ZOOM);
  const rect = cropRect(wide, SQUARE, zoomTo(wide, SQUARE, initialView(), 2));
  assert.deepEqual(rect, { x: 1250, y: 750, width: 1500, height: 1500 });
});

test('dragging cannot pull the image past the frame edge, at any zoom', () => {
  for (const image of [wide, tall, { width: 640, height: 640 }]) {
    for (const aspect of [SQUARE, COVER]) {
      for (const zoom of [1, 1.5, MAX_ZOOM]) {
        let view = zoomTo(image, aspect, initialView(), zoom);
        for (const [dx, dy] of [
          [5, 0],
          [-5, 0],
          [0, 5],
          [0, -5],
          [3, -7],
          [0.01, 0.02],
        ]) {
          view = panBy(image, aspect, view, dx, dy);
          assert.ok(
            inside(image, cropRect(image, aspect, view)),
            `${image.width}x${image.height} aspect ${aspect} zoom ${zoom}`,
          );
        }
      }
    }
  }
});

test('moving the image right shows more of its left side', () => {
  const zoomed = zoomTo(wide, SQUARE, initialView(), 2);
  const moved = panBy(wide, SQUARE, zoomed, 0.1, 0);
  // 0.1 of the frame is 150 source pixels at this zoom.
  assert.equal(cropRect(wide, SQUARE, moved).x, 1250 - 150);
  // Pushed all the way, it stops at the image's own left edge.
  assert.equal(cropRect(wide, SQUARE, panBy(wide, SQUARE, moved, 10, 0)).x, 0);
});

test('zooming out after moving to an edge pulls the crop back inside', () => {
  const corner = panBy(
    wide,
    SQUARE,
    zoomTo(wide, SQUARE, initialView(), MAX_ZOOM),
    -10,
    -10,
  );
  const out = zoomTo(wide, SQUARE, corner, 1);
  assert.ok(inside(wide, cropRect(wide, SQUARE, out)));
  assert.deepEqual(cropRect(wide, SQUARE, out), {
    x: 1000,
    y: 0,
    width: 3000,
    height: 3000,
  });
});

test('a view from elsewhere (bad numbers) is made safe', () => {
  const view = clampView(wide, SQUARE, { x: -3, y: 9, zoom: 0 });
  assert.equal(view.zoom, 1);
  assert.ok(inside(wide, cropRect(wide, SQUARE, view)));
  const empty = { width: 0, height: 0 };
  assert.deepEqual(cropRect(empty, SQUARE, initialView()), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});

test('the preview places the image so the frame shows exactly the crop', () => {
  const view = zoomTo(wide, SQUARE, initialView(), 2);
  // The crop is 1500 px square: the whole 4000x3000 image is 266.67% x 200% of the frame,
  // shifted so the crop's corner (1250, 750) sits at the frame's corner.
  const place = imagePlacement(wide, SQUARE, view);
  assert.ok(Math.abs(place.width - 266.6666667) < 1e-6);
  assert.ok(Math.abs(place.height - 200) < 1e-9);
  assert.ok(Math.abs(place.left - -83.3333333) < 1e-6);
  assert.ok(Math.abs(place.top - -50) < 1e-9);
});

test('the saved image is the crop, never larger than the size the server keeps', () => {
  assert.deepEqual(outputSize({ width: 3000, height: 3000 }, 1024), {
    width: 1024,
    height: 1024,
  });
  assert.deepEqual(outputSize({ width: 400, height: 400 }, 1024), {
    width: 400,
    height: 400,
  });
  const cover = outputSize({ width: 4000, height: 4000 / COVER }, 2240);
  assert.deepEqual(cover, { width: 2240, height: 600 });
});
