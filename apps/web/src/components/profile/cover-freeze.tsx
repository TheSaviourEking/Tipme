'use client';

import { useEffect } from 'react';

/**
 * Stops an animated cover while someone tips, and while it is off screen (owner's exception,
 * EXPERIENCE-AND-MOTION 7.11). The first use of the tip form (focus, press, typing, or a submit
 * in flight) sets `data-cover-frozen` on the cover and it stays set for the whole page view: the
 * payment moment must stay still, so leaving the field never resumes it. Off screen only pauses
 * (`data-cover-offscreen`), and a loop resumes on return unless frozen. The CSS does the pausing,
 * so a paused animation holds the frame it reached. Renders nothing.
 */
export function CoverFreeze({
  coverSelector = '.profile-cover',
}: {
  coverSelector?: string;
}) {
  useEffect(() => {
    const cover = document.querySelector<HTMLElement>(coverSelector);
    if (!cover) return;
    const panel = document.querySelector<HTMLElement>('[data-tip-panel]');
    const cleanups: (() => void)[] = [];
    const freeze = () => cover.setAttribute('data-cover-frozen', '');

    if (panel) {
      for (const type of ['focusin', 'pointerdown', 'input'] as const) {
        panel.addEventListener(type, freeze, { once: true });
        cleanups.push(() => panel.removeEventListener(type, freeze));
      }
      // A submit in flight marks its form; the form may also be mounted after this effect runs.
      const watcher = new MutationObserver(() => {
        if (panel.querySelector('form[data-submitting]')) freeze();
      });
      watcher.observe(panel, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-submitting'],
      });
      cleanups.push(() => watcher.disconnect());
      if (panel.querySelector('form[data-submitting]')) freeze();
    }

    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        cover.toggleAttribute('data-cover-offscreen', !entry.isIntersecting);
      },
      { threshold: 0 },
    );
    seen.observe(cover);
    cleanups.push(() => seen.disconnect());

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [coverSelector]);

  return null;
}
