import { SetMetadata } from '@nestjs/common';

export const OPENAPI_IMAGE = 'tipme:openapi-image';

export interface ImageResponseDoc {
  /** What the picture is, and how it is cached. */
  description: string;
  /** A whole-number query parameter limited to a fixed list. */
  size?: readonly number[];
  /** Response headers worth knowing about, by name. */
  headers?: Record<string, string>;
}

/** Marks a route that answers with a PNG, so the document says so instead of showing JSON. */
export const ImageResponse = (doc: ImageResponseDoc) =>
  SetMetadata(OPENAPI_IMAGE, doc);
