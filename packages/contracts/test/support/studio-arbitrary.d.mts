// Types for studio-arbitrary.mjs, for TypeScript callers (the Playwright render test).
import type fc from 'fast-check';
import type { StudioCheckContext, StudioDocument } from '../../dist/index.js';

export { default as fc } from 'fast-check';
export declare const TODAY: string;
export declare const IMAGE_POOL: readonly string[];
export declare const VIDEO_POOL: readonly string[];
export declare function studioDocument(options?: {
  valid?: boolean;
}): fc.Arbitrary<StudioDocument>;
export declare function checkContext(): fc.Arbitrary<StudioCheckContext>;
export declare function repairToPassing(
  doc: StudioDocument,
  ctx: StudioCheckContext,
): StudioDocument | null;
export declare function studioPassingDocument(): fc.Arbitrary<{
  doc: StudioDocument;
  ctx: StudioCheckContext;
}>;
