'use client';
import { useEffect } from 'react';

/**
 * Home only. While the hero claim form is on screen, the header's "Claim your username" button
 * steps aside (it would say the same thing twice); once the form scrolls away, the button comes
 * back. This renders nothing: it sets `data-hero-claim="in"` on <html> and the stylesheet does the
 * rest, so with no JavaScript, or before this runs, the button stays shown. Wide screens only
 * (globals.css): on a phone the button lives in the open menu.
 */
export function HeaderClaimGate() {
  useEffect(() => {
    const form = document.querySelector('.home-claim');
    if (!form || typeof IntersectionObserver === 'undefined') return;
    const root = document.documentElement;
    // The sticky header covers the top of the screen: a form scrolled up under it is out of sight,
    // so it counts as gone and the button shows (never both hidden).
    const header = Number.parseFloat(
      getComputedStyle(root).getPropertyValue('--nav-height'),
    );
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) root.dataset.heroClaim = 'in';
        else delete root.dataset.heroClaim;
      },
      { rootMargin: `-${Number.isFinite(header) ? header : 76}px 0px 0px 0px` },
    );
    observer.observe(form);
    return () => {
      observer.disconnect();
      delete root.dataset.heroClaim;
    };
  }, []);
  return null;
}
