'use client';
import { useEffect, useRef } from 'react';
import { ActionLink, Card } from '@tipme/ui';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { ShareProfile } from './share-profile';

/**
 * In place of the tip form while checkout is closed (Bachs live, live payments switched off):
 * said before a supporter chooses an amount, and no pay button anywhere. `announce` is for the
 * form closing itself after a refusal: the card is a polite live region and its heading takes
 * focus, so a screen reader user is not left on a button that has gone. `handle` is for a
 * person's own page: their supporters can still pass the page on. `name` is their first name,
 * and the way on is to claim a page of one's own (ScreenSmall: the signature card).
 */
export function TippingOpensSoon({
  announce = false,
  handle,
  name,
}: {
  announce?: boolean;
  handle?: string;
  name?: string;
}) {
  const copy = paymentModeCopy('closed');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (announce) heading.current?.focus();
  }, [announce]);
  return (
    <Card
      material="signature"
      className="appreciation-card tips-not-ready"
      {...(announce ? { role: 'status' } : {})}
    >
      <h2 ref={heading} {...(announce ? { tabIndex: -1 } : {})}>
        {name ? `${copy.closedTitle} on ${name}’s page.` : copy.closedTitle}
      </h2>
      <p className="composer-description">{copy.closedBody}</p>
      <ActionLink
        href="/sign-up"
        variant="continue"
        className="tips-not-ready__claim"
      >
        Claim your username
      </ActionLink>
      {handle && <ShareProfile handle={handle} variant="text" />}
    </Card>
  );
}
