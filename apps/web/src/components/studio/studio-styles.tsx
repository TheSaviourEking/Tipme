'use client';
import dynamic from 'next/dynamic';

/**
 * Loads studio.css only where a Studio page renders. Imported straight from the renderer, the
 * sheet belonged to the /@username route, so each link to a public page that Next.js prefetched
 * (the dashboard's "View my page", the footer's demo link) added a `<link rel="preload"
 * as="style">` for it, and Chrome warned that the preload went unused (17 Nov 2026). Behind
 * next/dynamic the sheet is linked, render-blocking as before, only in the HTML of a page that
 * shows a design (and in the dashboard's Studio preview).
 */
const Sheet = dynamic(() => import('./studio-sheet'));

export function StudioStyles() {
  return <Sheet />;
}
