'use client';

import { useState } from 'react';

/**
 * A Studio video (plan Task 5). Until the visitor taps play there is no request to the video site:
 * no frame, no thumbnail, no preconnect. The still is drawn by TipMe in the page's own colours.
 * The frame comes only from STUDIO_EMBED_ORIGINS (the CSP's frame-src, Task 8).
 */
export function VideoEmbed({
  src,
  site,
  caption,
}: {
  src: string;
  site: string;
  caption?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const name = caption ? `${caption} (${site})` : `Video on ${site}`;
  if (playing)
    return (
      <iframe
        className="studio-video__frame"
        src={src}
        title={name}
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin"
        allowFullScreen
      />
    );
  return (
    <button
      type="button"
      className="studio-video__still"
      onClick={() => setPlaying(true)}
    >
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <circle cx="24" cy="24" r="23" fill="currentColor" opacity="0.18" />
        <path d="M19 15l15 9-15 9z" fill="currentColor" />
      </svg>
      <span className="studio-video__words studio-text">
        <span className="studio-video__title">Play {name}</span>
        <span className="studio-video__note">
          Loads from {site} when you tap
        </span>
      </span>
    </button>
  );
}
