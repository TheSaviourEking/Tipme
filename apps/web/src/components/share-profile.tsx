'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@tipme/ui';

const COPIED = 'Link copied.';
const UNAVAILABLE =
  'Copy is unavailable. You can copy the page address from your browser.';

/**
 * Copies a page's link: an icon button by the name, or a labelled button in a panel. The label or
 * note changes for two seconds and nothing moves. The status element stays rendered, so a screen
 * reader hears the change.
 */
export function ShareProfile({
  handle,
  variant = 'icon',
}: {
  handle: string;
  variant?: 'icon' | 'text';
}) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/@${handle}`,
      );
      setStatus(COPIED);
      timer.current = setTimeout(() => setStatus(''), 2000);
    } catch {
      // Longer than a note that only confirms: this one asks them to do something.
      setStatus(UNAVAILABLE);
      timer.current = setTimeout(() => setStatus(''), 6000);
    }
  };
  return (
    <div className={`share-profile share-profile--${variant}`}>
      {variant === 'icon' ? (
        <Button
          className="share-profile__icon"
          variant="secondary"
          aria-label="Share this page"
          onClick={() => void copy()}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 15V4" />
            <path d="m7.5 8 4.5-4.5L16.5 8" />
            <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
          </svg>
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => void copy()}>
          {status === COPIED ? COPIED : 'Copy page link'}
        </Button>
      )}
      <p
        role="status"
        className="tm-hint share-profile__status"
        {...(status === COPIED ? { 'data-copied': '' } : {})}
      >
        {status}
      </p>
    </div>
  );
}
