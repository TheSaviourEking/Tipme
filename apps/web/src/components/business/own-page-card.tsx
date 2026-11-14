'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Button } from '@tipme/ui';
import { HandleClaim } from '@/components/account/handle-claim';

// Business sign-up, Task D4: a login with a business and no page is offered one, quietly. "Not now"
// hides the card on this device for 90 days (R18); Settings keeps the same offer.

const HIDDEN_UNTIL = 'tipme.own-page-card-hidden-until';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function hiddenNow(): boolean {
  try {
    return Number(localStorage.getItem(HIDDEN_UNTIL) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

export function OwnPageCard({
  place = 'business',
  businessName,
}: {
  /** On the business, with "Not now"; in Settings as "Your own page", always there. */
  place?: 'business' | 'settings';
  businessName?: string;
}) {
  const id = useId();
  const router = useRouter();
  // The dashboard draws in the browser only (after the login is read), so this device's choice is
  // read as the card first draws.
  const [hidden, setHidden] = useState(
    () => place === 'business' && typeof window !== 'undefined' && hiddenNow(),
  );
  const [claiming, setClaiming] = useState(false);
  if (hidden) return null;

  const notNow = () => {
    try {
      localStorage.setItem(HIDDEN_UNTIL, String(Date.now() + NINETY_DAYS_MS));
    } catch {
      // Storage blocked: hidden for this visit only.
    }
    setHidden(true);
  };
  const title = place === 'settings' ? 'Your own page' : 'Want tips yourself?';
  return (
    <section
      className="own-page-card"
      aria-labelledby={`${id}-title`}
      id={place === 'settings' ? 'own-page' : undefined}
      tabIndex={place === 'settings' ? -1 : undefined}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      {claiming ? (
        // The same handle step as sign-up, then the welcome, without signing in again.
        <HandleClaim onClaimed={() => router.replace('/dashboard/welcome')} />
      ) : (
        <>
          <p>
            {place === 'settings' && 'Want tips yourself? '}Turn on your own
            page: a link and QR code in your name, on this same login. Customers
            who love what you do can thank you directly.
          </p>
          <div className="own-page-card__actions">
            <Button variant="secondary" onClick={() => setClaiming(true)}>
              Turn on your page
            </Button>
            {place === 'business' && (
              <Button variant="quiet" onClick={notNow}>
                Not now
              </Button>
            )}
          </div>
          <p className="tm-hint">
            Choose a handle, that’s all.
            {businessName ? ` ${businessName} doesn’t change.` : ''}
          </p>
        </>
      )}
    </section>
  );
}
