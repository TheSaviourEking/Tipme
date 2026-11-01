'use client';
import { useEffect, useRef } from 'react';
import { Card } from '@tipme/ui';
import { paymentModeCopy } from '@/lib/payment-mode-copy';

/**
 * In place of the tip form while checkout is closed (Bachs live, live payments switched off):
 * said before a supporter chooses an amount, and no pay button anywhere. `announce` is for the
 * form closing itself after a refusal: the card is a polite live region and its heading takes
 * focus, so a screen reader user is not left on a button that has gone.
 */
export function TippingOpensSoon({ announce = false }: { announce?: boolean }) {
  const copy = paymentModeCopy('closed');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (announce) heading.current?.focus();
  }, [announce]);
  return (
    <Card
      className="appreciation-card tips-not-ready"
      {...(announce ? { role: 'status' } : {})}
    >
      <h2 ref={heading} {...(announce ? { tabIndex: -1 } : {})}>
        {copy.closedTitle}
      </h2>
      <p className="composer-description">{copy.closedBody}</p>
    </Card>
  );
}
