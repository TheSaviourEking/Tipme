import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_IMAGE_SHAPES,
  apiErrorCodes,
  studioDraftSchema,
  studioFocusSchema,
  studioImageFileName,
  studioPublishSchema,
} from '../dist/index.js';
import { KEMI } from './fixtures/studio-examples.mjs';

const V2 = {
  v: 2,
  style: 'clear',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [{ id: 'blk00001', kind: 'quote', text: 'Sang like home.' }],
};

test('Page Studio has its own error codes', () => {
  for (const code of [
    'STUDIO_DRAFT_STALE',
    'STUDIO_DESIGN_CHECK_FAILED',
    'STUDIO_PRO_REQUIRED',
    'IMAGE_TOO_SMALL',
    'STUDIO_IMAGE_LIMIT',
  ])
    assert.ok(apiErrorCodes.includes(code), code);
});

test('saving a draft takes the revision it was based on and a valid document', () => {
  assert.equal(
    studioDraftSchema.safeParse({ rev: 3, draft: V2 }).success,
    true,
  );
  for (const bad of [
    { draft: V2 },
    { rev: -1, draft: V2 },
    { rev: 1.5, draft: V2 },
    { rev: 0, draft: { ...V2, css: 'x' } },
    { rev: 0, draft: V2, extra: true },
    // The old editor's v1 document (ruling R1: refused since PR 4a).
    { rev: 0, draft: KEMI },
  ])
    assert.equal(
      studioDraftSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 60),
    );
  assert.equal(studioPublishSchema.safeParse({ rev: 0 }).success, true);
  assert.equal(
    studioPublishSchema.safeParse({ rev: 0, force: true }).success,
    false,
    'no publish anyway',
  );
});

test('a focal point is a whole percentage across and down', () => {
  assert.equal(
    studioFocusSchema.safeParse({ focalX: 0, focalY: 100 }).success,
    true,
  );
  for (const bad of [
    { focalX: 101, focalY: 0 },
    { focalX: 50.5, focalY: 50 },
    { focalX: 50 },
  ])
    assert.equal(
      studioFocusSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test('photo files are named by shape and width, and nothing else', () => {
  assert.deepEqual(STUDIO_IMAGE_SHAPES, ['square', 'wide', 'tall', 'strip']);
  assert.deepEqual(studioImageFileName('square-960'), {
    shape: 'square',
    width: 960,
  });
  for (const bad of [
    'master',
    'square-961',
    'circle-480',
    '../square-480',
    'square-480.webp',
  ])
    assert.equal(studioImageFileName(bad), null, bad);
});
