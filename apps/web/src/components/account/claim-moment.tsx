'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@tipme/ui';
import { STANDARD_TIP_PRESETS_MINOR } from '@tipme/domain';
import { claimBuzz, endsClaimMoment } from '@/lib/claim-moment';
import { Money } from '@/components/money';

/** When the card touches down, for the buzz (the timeline is in globals.css, `.claim-moment`). */
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
 * "@username is yours.": shown once, over the hello step, after the server confirmed the claim.
 * The page card falls and lands, the stamp presses, purple hearts rise and the words arrive. It
 * stays until the person moves on: Continue, Escape, Enter, or a tap once the card is down (the
 * claim tap itself never counts) hands over (`onDone`). Tab goes round inside it. Reduced motion
 * gets the still scene and no vibration. The scene is a picture: screen readers hear the heading
 * and one polite line.
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
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [still] = useState(prefersStill);
  // Filled after mount, so the live region exists before its words do and they are announced.
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    title.current?.focus();
    const shownAt = performance.now();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        // The moment covers the page (aria-modal): Tab goes round inside it, never behind it.
        const stops = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled])',
          ) ?? []),
        ];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (!first || !last) return;
        const at = document.activeElement;
        const inside = at instanceof HTMLElement && stops.includes(at);
        if (event.shiftKey && (!inside || at === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || at === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (
        endsClaimMoment({ kind: 'key', key: event.key, repeat: event.repeat })
      ) {
        // Enter on Continue would also click it; one hand-over is enough.
        event.preventDefault();
        onDone();
      }
    };
    // A tap ends it on click, after the tap's own mousedown has moved focus, so the hand-over's
    // focus on the hello heading is the last word. Continue handles its own click.
    const onTap = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.claim-moment__continue')
      )
        return;
      if (
        endsClaimMoment({
          kind: 'tap',
          sinceShownMs: performance.now() - shownAt,
        })
      )
        onDone();
    };
    const announce = setTimeout(
      () =>
        setAnnouncement(
          `Your username @${handle} is claimed. Welcome to TipMe.`,
        ),
      50,
    );
    const buzz = setTimeout(() => claimBuzz(navigator, still), LAND_MS);
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onTap);
    return () => {
      clearTimeout(announce);
      clearTimeout(buzz);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onTap);
    };
  }, [handle, still, onDone]);

  const hearts = still ? 3 : 6;
  return (
    <div
      ref={dialog}
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
          {/* Pressed in its own space between the link and the amounts, never over them. */}
          <span className="claim-moment__stamp">@{handle} · YOURS</span>
          <span className="claim-moment__keys">
            {STANDARD_TIP_PRESETS_MINOR.map((amount) => (
              <span key={String(amount)}>
                <Money minor={amount} />
              </span>
            ))}
          </span>
          <span className="claim-moment__tip">
            Tip <Money minor={STANDARD_TIP_PRESETS_MINOR[0]} />
          </span>
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
        Welcome to TipMe. People can start tipping you the moment your page is
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
