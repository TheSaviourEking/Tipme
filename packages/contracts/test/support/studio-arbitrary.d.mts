// Types for studio-arbitrary.mjs, for TypeScript callers (the Playwright render tests).
import type fc from 'fast-check';
import type { StudioDocument, StudioDocumentV1 } from '../../dist/index.js';

export { default as fc } from 'fast-check';
export declare const TODAY: string;
export declare const IMAGE_POOL: readonly string[];
export declare const VIDEO_POOL: readonly string[];
export declare function studioDocumentV1Arb(options?: {
  valid?: boolean;
}): fc.Arbitrary<StudioDocumentV1>;
export declare function studioDocumentArb(options?: {
  valid?: boolean;
}): fc.Arbitrary<StudioDocument>;
