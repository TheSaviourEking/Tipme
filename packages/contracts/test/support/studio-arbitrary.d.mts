// Types for studio-arbitrary.mjs, for TypeScript callers (the Playwright render test).
import type fc from 'fast-check';
import type {
  StudioCheckContextV1,
  StudioDocumentV1,
} from '../../dist/index.js';

export { default as fc } from 'fast-check';
export declare const TODAY: string;
export declare const IMAGE_POOL: readonly string[];
export declare const VIDEO_POOL: readonly string[];
export declare function studioDocumentV1Arb(options?: {
  valid?: boolean;
}): fc.Arbitrary<StudioDocumentV1>;
export declare function checkContext(): fc.Arbitrary<StudioCheckContextV1>;
export declare function repairToPassing(
  doc: StudioDocumentV1,
  ctx: StudioCheckContextV1,
): StudioDocumentV1 | null;
export declare function studioPassingDocument(): fc.Arbitrary<{
  doc: StudioDocumentV1;
  ctx: StudioCheckContextV1;
}>;
