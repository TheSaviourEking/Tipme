/**
 * Page Studio over the API (plan Task 7): what the editor saves and reads, and how photo files are
 * named. The routes answer 404 while Page Studio is switched off.
 */
import { z } from 'zod';
import type { StudioCheckContext, StudioCheckResult } from './studio-check.js';
import {
  studioDocumentSchema,
  type StudioDocument,
} from './studio-document.js';

/** Edit: Pro. Preview: Free, an in-memory draft that is never stored. Lapsed: kept, read-only. */
export type StudioAccess = 'edit' | 'preview' | 'lapsed';

/** One of the page's Studio photos, as the editor shows it. `path` + `/<shape>-<width>` is a file. */
export interface StudioImage {
  imageId: string;
  path: string;
  width: number;
  height: number;
  focalX: number;
  focalY: number;
}

/** `GET /v1/me/studio`, and the answer to every Studio write. */
export interface MyStudio {
  draft: StudioDocument;
  published: StudioDocument | null;
  /** Bumped by every save: a save must name the revision it was based on. */
  rev: number;
  publishedAt: string | null;
  /** The design check of the draft with the server's facts; the editor shows this one. */
  check: StudioCheckResult;
  /** Those facts, so the editor's own instant check agrees with the server's. */
  context: StudioCheckContext;
  images: StudioImage[];
  access: StudioAccess;
}

/** `PUT /v1/me/studio/draft`. Saving never needs a passing check; publishing does. */
export const studioDraftSchema = z.strictObject({
  rev: z.number().int().min(0),
  draft: studioDocumentSchema,
});
export type StudioDraftRequest = z.infer<typeof studioDraftSchema>;

/** `POST /v1/me/studio/publish`. There is no "publish anyway" (owner ruling 12). */
export const studioPublishSchema = z.strictObject({
  rev: z.number().int().min(0),
});
export type StudioPublishRequest = z.infer<typeof studioPublishSchema>;

/** `PUT /v1/me/studio/images/:imageId/focus`: the point every crop keeps in view. */
export const studioFocusSchema = z.strictObject({
  focalX: z.number().int().min(0).max(100),
  focalY: z.number().int().min(0).max(100),
});
export type StudioFocusRequest = z.infer<typeof studioFocusSchema>;

/** The crops TipMe makes of each photo; `strip` is a row background. */
export const STUDIO_IMAGE_SHAPES = ['square', 'wide', 'tall', 'strip'] as const;
export type StudioImageShape = (typeof STUDIO_IMAGE_SHAPES)[number];
/** Each crop at these widths, never wider than the photo allows. */
export const STUDIO_IMAGE_WIDTHS = [480, 960, 1440] as const;

/** `square-960` → its shape and width; anything else (a master, a path) → null. */
export function studioImageFileName(file: string): {
  shape: StudioImageShape;
  width: (typeof STUDIO_IMAGE_WIDTHS)[number];
} | null {
  const m = /^(square|wide|tall|strip)-(480|960|1440)$/.exec(file);
  return m
    ? {
        shape: m[1] as StudioImageShape,
        width: Number(m[2]) as (typeof STUDIO_IMAGE_WIDTHS)[number],
      }
    : null;
}
