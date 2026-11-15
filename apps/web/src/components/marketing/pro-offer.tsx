'use client';
import { useEffect, useRef, useState } from 'react';
import type { MyPro } from '@tipme/contracts';
import { ActionLink, Button, Skeleton, Slip } from '@tipme/ui';
import { naira } from '@/lib/money';
import { dateOf } from '@/lib/lagos-time';
import {
  ASK_FOR_PRO,
  PLAN_HREF,
  readMyPro,
  readPrice,
  startPurchase,
  type PriceState,
} from '@/lib/pro-buy';
import { readSignedInHint } from '@/lib/signed-in-hint';

const SIGN_IN = '/sign-in?next=%2Fpro';

type Viewer =
  | { kind: 'unknown' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; pro: MyPro };

/**
 * The /pro page's price block and, on a phone, its foot key (ProPage board). The price is read from
 * the server every time; "Get Pro" shows only when buying is switched on and a price is set.
 */
export function ProOffer({
  freePercent,
  proPercent,
}: {
  freePercent: number;
  proPercent: number;
}) {
  const [price, setPrice] = useState<PriceState>({ kind: 'loading' });
  const [viewer, setViewer] = useState<Viewer>({ kind: 'unknown' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [blockInView, setBlockInView] = useState(true);
  const block = useRef<HTMLElement>(null);

  const load = async () => {
    const read = await readPrice();
    setPrice(read);
    // Only the API knows who is signed in (the hint can lag a fresh sign-in). Ask it when it
    // matters: buying is open, or this browser says someone is signed in.
    const buying = read.kind === 'price' && read.price.billingOn;
    if (!buying && !readSignedInHint()) {
      setViewer({ kind: 'signed-out' });
      return;
    }
    const mine = await readMyPro();
    setViewer(
      mine.ok ? { kind: 'signed-in', pro: mine.data } : { kind: 'signed-out' },
    );
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    void load();
  }, []);

  useEffect(() => {
    const node = block.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setBlockInView(Boolean(entry?.isIntersecting)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const amount = price.kind === 'price' ? price.price.amountMinor : null;
  const mine = viewer.kind === 'signed-in' ? viewer.pro : null;
  const onPro = mine?.plan === 'pro';
  const billingOn =
    price.kind === 'price' &&
    price.price.billingOn &&
    (mine ? mine.billingOn : true);
  const settled = price.kind !== 'loading' && viewer.kind !== 'unknown';

  const buy = async () => {
    if (!amount) return;
    setBusy(true);
    setProblem('');
    const result = await startPurchase(amount);
    if (result.ok) return;
    setBusy(false);
    setProblem(result.message);
    if (result.priceChanged) void load();
  };

  const getPro = (label: string, className?: string) =>
    viewer.kind === 'signed-in' ? (
      <Button
        variant="continue"
        className={className}
        aria-busy={busy}
        disabled={busy}
        onClick={() => void buy()}
      >
        {label}
      </Button>
    ) : (
      <ActionLink variant="continue" className={className} href={SIGN_IN}>
        {label}
      </ActionLink>
    );

  return (
    <>
      <section
        ref={block}
        className="pro-offer"
        aria-labelledby="pro-offer-title"
      >
        <h2 id="pro-offer-title" className="pro-offer__name">
          TipMe Pro<span className="sr-only"> price</span>
        </h2>
        {price.kind === 'loading' && <Skeleton label="Loading the price" />}
        {price.kind === 'price' && (
          <p className="pro-offer__price">
            <span className="pro-offer__amount">
              {naira(price.price.amountMinor)}
            </span>
            <span className="pro-offer__per">a month</span>
          </p>
        )}
        {price.kind === 'none' && (
          <p className="pro-offer__price">
            <span className="pro-offer__amount pro-offer__amount--soon">
              Price coming soon
            </span>
          </p>
        )}
        {price.kind === 'error' && (
          <Slip
            tone="error"
            title="We couldn’t load the price"
            actions={
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        )}
        {settled && price.kind !== 'error' && (
          <>
            {onPro ? (
              <>
                <p className="pro-offer__on">
                  {mine?.source === 'paid' && mine.current
                    ? `You’re on Pro · paid until ${dateOf(mine.current.endsAt)}`
                    : 'You’re on Pro'}
                </p>
                <ActionLink variant="secondary" href={PLAN_HREF}>
                  Manage
                </ActionLink>
              </>
            ) : billingOn ? (
              <>
                <p className="pro-offer__line">
                  One plan, everything below. Cancel any time. On Pro, TipMe
                  keeps {proPercent}% of each tip instead of {freePercent}%.
                </p>
                {getPro('Get Pro', 'pro-offer__go')}
                {problem && (
                  <p className="pro-offer__problem" role="alert">
                    {problem}
                  </p>
                )}
                <p className="pro-offer__small">
                  Pay by card or bank transfer, through our payment partner.
                </p>
              </>
            ) : (
              <>
                <p className="pro-offer__soon" role="status">
                  <strong>Pro is coming soon to buy.</strong> We’ll show how to
                  pay here when it’s ready.
                </p>
                <ActionLink variant="secondary" href={ASK_FOR_PRO}>
                  Ask for Pro
                </ActionLink>
                <p className="pro-offer__small">
                  Until then, the TipMe team can turn Pro on for your page.
                </p>
              </>
            )}
          </>
        )}
      </section>
      {/* On a phone the buy key waits at the foot once the price block has scrolled away. */}
      {settled && !onPro && price.kind !== 'error' && (
        <div className="pro-foot" hidden={blockInView}>
          {billingOn && amount ? (
            getPro(`Get Pro · ${naira(amount)} a month`, 'pro-foot__key')
          ) : (
            <span
              className="pro-foot__key pro-foot__key--off"
              aria-disabled="true"
            >
              Coming soon to buy
            </span>
          )}
        </div>
      )}
    </>
  );
}
