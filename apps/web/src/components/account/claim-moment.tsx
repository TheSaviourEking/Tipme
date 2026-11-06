'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@tipme/ui';
import { STANDARD_TIP_PRESETS_MINOR } from '@tipme/domain';
import { CLAIM_MOMENT_MS, claimBuzz } from '@/lib/claim-moment';
import { formatNaira } from '@/lib/demo-amount';

/** When the card lands (the timeline is in globals.css, `.claim-moment`). */
const LAND_MS = 350;

/** The heart from the master wordmark, as `icon.svg` draws it. */
function Heart({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="668 -13 120 120" focusable="false">
      <path
        d="M701.259 76.9553L701.236 77.167C737.151 92.0868 770.727 77.7807 769.62 56.2653C768.512 34.7487 741.619 36.1332 741.619 36.1332L741.525 36.0404C741.525 36.0404 742.479 9.12833 720.948 8.36497C699.419 7.60052 685.767 41.2835 701.259 76.9553Z"
        transform="translate(728 47) scale(0.78) translate(-732.13 -45.83)"
        fill="currentColor"
      />
    </svg>
  );
}

const prefersStill = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * "@handle is yours.": shown once, over the hello step, after the server confirmed the claim. The
 * page card falls and lands, the stamp presses, purple hearts rise and the words arrive. At 1.6 s,
 * or on any tap, any key, Continue or Escape, it hands over (`onDone`). Reduced motion gets the
 * still scene and no vibration. The scene is a picture: screen readers hear the heading and one
 * polite line.
 */
export function ClaimMoment({
  handle,
  host,
  onDone,
}: {
  handle: string;
  host: string;
  onDone: () => void;
}) {
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const [still] = useState(prefersStill);
  // Filled after mount, so the live region exists before its words do and they are announced.
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    title.current?.focus();
    const finish = () => onDone();
    const announce = setTimeout(
      () =>
        setAnnouncement(`Your handle @${handle} is claimed. Welcome to TipMe.`),
      50,
    );
    const buzz = setTimeout(() => claimBuzz(navigator, still), LAND_MS);
    const handOver = setTimeout(finish, CLAIM_MOMENT_MS);
    document.addEventListener('keydown', finish);
    // A tap ends it on click, after the tap's own mousedown has moved focus, so the hand-over's
    // focus on the hello heading is the last word.
    document.addEventListener('click', finish);
    return () => {
      clearTimeout(announce);
      clearTimeout(buzz);
      clearTimeout(handOver);
      document.removeEventListener('keydown', finish);
      document.removeEventListener('click', finish);
    };
  }, [handle, still, onDone]);

  const hearts = still ? 3 : 6;
  return (
    <div
      className={`claim-moment${still ? ' claim-moment--still' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-lede`}
    >
      <div className="claim-moment__scene" aria-hidden="true">
        <div className="claim-moment__card">
          <span className="claim-moment__cover" />
          <span className="claim-moment__avatar">
            {handle.slice(0, 1).toUpperCase()}
          </span>
          <span className="claim-moment__name">{handle}</span>
          <span className="claim-moment__link">
            {host ? `${host}/@${handle}` : `/@${handle}`}
          </span>
          <span className="claim-moment__keys">
            {STANDARD_TIP_PRESETS_MINOR.map((amount) => (
              <span key={String(amount)}>{formatNaira(amount)}</span>
            ))}
          </span>
          <span className="claim-moment__tip">
            Tip {formatNaira(STANDARD_TIP_PRESETS_MINOR[0])}
          </span>
          <span className="claim-moment__stamp">@{handle} · YOURS</span>
        </div>
        {Array.from({ length: hearts }, (_, index) => (
          <Heart
            key={index}
            className={`claim-moment__heart claim-moment__heart--${index + 1}`}
          />
        ))}
      </div>
      <h2
        id={`${id}-title`}
        className="claim-moment__title"
        ref={title}
        tabIndex={-1}
      >
        @{handle} is yours.
      </h2>
      <p id={`${id}-lede`} className="claim-moment__lede">
        Welcome to TipMe. People can start thanking you the moment your page is
        online.
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <Button
        variant="secondary"
        className="claim-moment__continue"
        onClick={onDone}
      >
        Continue
      </Button>
    </div>
  );
}
