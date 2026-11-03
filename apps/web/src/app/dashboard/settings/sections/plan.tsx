'use client';
import { useRecipient } from '@/components/account/recipient-context';
import { Card } from '@tipme/ui';

// Plan (ScreenSettings).

/** What Pro includes, for every plan. Nothing to buy here: staff arrange Pro for now. No price is named. */
export function ProPlan() {
  const { profile } = useRecipient();
  const pro = profile.plan === 'pro';
  return (
    <Card id="pro" className="settings-section">
      <h2>TipMe Pro</h2>
      <p className="tm-hint">
        {pro ? 'Your page is on TipMe Pro.' : 'Your page is on the Free plan.'}{' '}
        Pro includes:
      </p>
      <ul className="settings-list">
        <li>
          Pro QR designs, and print formats such as a counter card, poster or
          sticker. Free pages keep the three standard QR looks.
        </li>
        <li>
          Three changes to your handle. Free pages keep the handle they claimed.
        </li>
        <li>Your own tip amounts</li>
        <li>No “Get your own TipMe page” link at the foot of your page</li>
      </ul>
      <p className="tm-hint">
        Covers are free on every plan, so choosing one below costs nothing.
      </p>
      {!pro && (
        <p className="tm-hint">
          The TipMe team turns Pro on for your page, and this page will show it
          when they do.
        </p>
      )}
    </Card>
  );
}
