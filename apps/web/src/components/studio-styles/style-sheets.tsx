'use client';
import dynamic from 'next/dynamic';
import type { StudioStyleId } from '@tipme/contracts';

/**
 * Each style's stylesheet (frame.css plus its own), loaded only where a page of that style
 * renders. Behind next/dynamic a sheet is linked, render-blocking, only in the HTML of a page that
 * renders it, and no prefetch of a /@username link preloads it (the reason studio.css moved behind
 * the same loader, studio-styles.tsx). Every style has one (route-css.test.mjs holds it so).
 */
const SHEETS: Record<StudioStyleId, ReturnType<typeof dynamic>> = {
  classic: dynamic(() => import('./sheets/classic')),
  clear: dynamic(() => import('./sheets/clear')),
  journal: dynamic(() => import('./sheets/journal')),
  linen: dynamic(() => import('./sheets/linen')),
  stage: dynamic(() => import('./sheets/stage')),
  horizon: dynamic(() => import('./sheets/horizon')),
  signboard: dynamic(() => import('./sheets/signboard')),
  sprint: dynamic(() => import('./sheets/sprint')),
  tiles: dynamic(() => import('./sheets/tiles')),
  creator: dynamic(() => import('./sheets/creator')),
  professional: dynamic(() => import('./sheets/professional')),
};

export function StyleSheet({ styleId }: { styleId: StudioStyleId }) {
  const Sheet = SHEETS[styleId];
  return <Sheet />;
}
