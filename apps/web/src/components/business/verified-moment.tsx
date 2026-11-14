'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { BusinessDetail } from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

// Business sign-up, Task D5: once, the first visit after TipMe verified the business (the server
// says so: `you.celebrate`, R19). Seen as soon as it shows; hearts settle, and with reduced motion
// nothing moves and the words are the same.

const HEART =
  'M12 21s-7.5-4.6-9.6-9.3C1 8.4 3 5 6.4 5c2.2 0 4 1.2 5.6 3.4C13.6 6.2 15.4 5 17.6 5 21 5 23 8.4 21.6 11.7 19.5 16.4 12 21 12 21z';

export function VerifiedMoment({ business }: { business: BusinessDetail }) {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    void apiFetch(`/v1/me/businesses/${business.id}/verified-seen`, {
      method: 'POST',
      body: {},
    });
  }, [business.id]);
  const location = business.locations.find((place) => !place.closed);
  const base = `/dashboard/business?business=${business.id}`;
  return (
    <section className="verified-moment" aria-label="Verified by TipMe">
      <div className="verified-moment__hearts" aria-hidden="true">
        {[0, 1, 2].map((n) => (
          <svg key={n} viewBox="0 0 24 24" className="verified-moment__heart">
            <path d={HEART} />
          </svg>
        ))}
      </div>
      <p className="verified-moment__stamp">Verified by TipMe</p>
      <h2>{business.name} is live.</h2>
      <p>
        {location
          ? `Your ${location.name} code is ready. Put it where customers pay, then invite your staff.`
          : 'Your codes are ready. Put them where customers pay, then invite your staff.'}
      </p>
      <div className="verified-moment__actions">
        <Link className="tm-button tm-button--primary" href={`${base}#codes`}>
          {location ? `Print your ${location.name} code` : 'Print your codes'}
        </Link>
        <Link
          className="tm-button tm-button--secondary"
          href={`${base}#people`}
        >
          Invite staff
        </Link>
      </div>
    </section>
  );
}
