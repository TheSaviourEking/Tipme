'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MyProfile, MyPro, ProPurchase } from '@tipme/contracts';
import { ActionLink, Button, Card, ProBadge, Skeleton, Slip } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { dateOf } from '@/lib/lagos-time';
import { naira } from '@/lib/money';
import {
  ASK_FOR_PRO,
  forgetPurchase,
  inGrace,
  readMyPro,
  readPurchase,
  returningPurchase,
  startPurchase,
} from '@/lib/pro-buy';
import { apiFetch } from '@/lib/session-client';
import { nextCheckDelay } from '@/lib/status-polling';
import { SettingsChapter } from './section';

// Plan (ScreenSettings; ProPage board's Settings line, ProBadge board's Settings Plan).

type Followed =
  | { kind: 'confirming'; purchase: ProPurchase | null }
  | { kind: 'paid' }
  | { kind: 'failed' }
  | { kind: 'expired' }
  | { kind: 'review' }
  | { kind: 'gave-up' };

const OPEN: ProPurchase['status'][] = ['PENDING', 'COLLECTING', 'UNKNOWN'];

/**
 * Follows the purchase this tab sent to the checkout. Only the server's reading of the partner's
 * confirmation says paid: the return from the checkout itself never does.
 */
function useReturnedPurchase(onSettled: () => void) {
  const [followed, setFollowed] = useState<Followed | null>(null);
  const [round, setRound] = useState(0);
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  });

  useEffect(() => {
    const purchaseId = returningPurchase();
    if (!purchaseId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the stored id is only readable in the browser
    setFollowed({ kind: 'confirming', purchase: null });
    const check = async (attempt: number) => {
      const result = await readPurchase(purchaseId);
      if (stopped) return;
      if (result.ok && !OPEN.includes(result.data.status)) {
        forgetPurchase();
        const status = result.data.status;
        setFollowed({
          kind:
            status === 'PAID'
              ? 'paid'
              : status === 'FAILED'
                ? 'failed'
                : status === 'EXPIRED'
                  ? 'expired'
                  : 'review',
        });
        settledRef.current();
        return;
      }
      if (!result.ok && result.status === 404) {
        forgetPurchase();
        setFollowed(null);
        return;
      }
      if (result.ok) setFollowed({ kind: 'confirming', purchase: result.data });
      const delay = nextCheckDelay(attempt, Date.now() - started);
      if (delay === null) {
        setFollowed({ kind: 'gave-up' });
        return;
      }
      timer = setTimeout(() => void check(attempt + 1), delay);
    };
    void check(0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [round]);

  return { followed, checkAgain: () => setRound((n) => n + 1) };
}

function FollowedSlip({
  followed,
  pro,
  onCheckAgain,
}: {
  followed: Followed;
  pro: MyPro | null;
  onCheckAgain: () => void;
}) {
  switch (followed.kind) {
    case 'confirming':
      return (
        <Slip tone="waiting" title="We’re confirming your payment">
          We’re waiting for our payment partner to confirm it. This page updates
          by itself.
          {followed.purchase?.checkoutUrl &&
            followed.purchase.status === 'PENDING' && (
              <>
                {' '}
                If you didn’t finish paying,{' '}
                <a href={followed.purchase.checkoutUrl}>continue to payment</a>.
              </>
            )}
        </Slip>
      );
    case 'paid':
      return (
        <Slip tone="done" title="Payment confirmed">
          {pro?.next
            ? `Thank you. Your next month runs to ${dateOf(pro.next.endsAt)}.`
            : pro?.current
              ? `Thank you. You’re on Pro until ${dateOf(pro.current.endsAt)}.`
              : 'Thank you. Your page is on Pro.'}
        </Slip>
      );
    case 'failed':
      return (
        <Slip tone="error" title="The payment didn’t go through">
          Your plan hasn’t changed. You can try again.
        </Slip>
      );
    case 'expired':
      return (
        <Slip tone="error" title="This payment timed out">
          Your plan hasn’t changed. You can start again.
        </Slip>
      );
    case 'review':
      return (
        <Slip tone="unsure" title="We’re checking this payment">
          Something about it needs a person to look. We’ll email you when it’s
          sorted.
        </Slip>
      );
    case 'gave-up':
      return (
        <Slip
          tone="unsure"
          title="We haven’t heard back about your payment yet"
          actions={
            <Button variant="secondary" onClick={onCheckAgain}>
              Check again
            </Button>
          }
        >
          Our payment partner hasn’t confirmed it. Your plan changes only once
          they do.
        </Slip>
      );
  }
}

/** What Pro includes, the current plan, and paying for a month when buying is open. */
export function ProPlan() {
  const { profile, setProfile } = useRecipient();
  const [pro, setPro] = useState<MyPro | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmingBuy, setConfirmingBuy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    const result = await readMyPro();
    if (result.ok) {
      setPro(result.data);
      setLoadFailed(false);
    } else setLoadFailed(true);
  }, []);

  const refresh = useCallback(() => {
    void load();
    // The plan unlocks Pro settings elsewhere on this screen; read the page again.
    void apiFetch<MyProfile>('/v1/me/profile').then((result) => {
      if (result.ok) setProfile(result.data);
    });
  }, [load, setProfile]);

  const { followed, checkAgain } = useReturnedPurchase(refresh);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    void load();
  }, [load]);

  const onPro = (pro?.plan ?? profile.plan) === 'pro';
  const price = pro?.price ?? null;
  const grace = inGrace(pro?.current ?? null);
  const canBuy = Boolean(pro?.billingOn && price) && !pro?.next;
  const following = followed?.kind === 'confirming';
  const open = !followed && pro?.openPurchase ? pro.openPurchase : null;
  const paidMonth = pro?.source === 'paid' || Boolean(pro?.current);
  const buyLabel = price
    ? paidMonth
      ? `Pay for next month · ${naira(price.amountMinor)}`
      : `Get Pro · ${naira(price.amountMinor)} a month`
    : '';
  const fromDate = pro?.current ? dateOf(pro.current.endsAt) : 'today';

  const buy = async () => {
    if (!price) return;
    setBusy(true);
    setProblem('');
    const result = await startPurchase(price.amountMinor);
    if (result.ok) return;
    setBusy(false);
    setConfirmingBuy(false);
    setProblem(result.message);
    if (result.priceChanged) void load();
  };

  return (
    <Card id="pro" className="settings-section settings-plan">
      <div className="settings-plan__head">
        <h3>TipMe Pro</h3>
        {onPro && <ProBadge />}
      </div>

      <p className="settings-plan__status">
        {!onPro
          ? 'Your page is on the Free plan.'
          : pro?.current && !grace
            ? `You’re on Pro, paid until ${dateOf(pro.current.endsAt)}.`
            : pro?.source === 'staff'
              ? 'Your page is on TipMe Pro, turned on by the TipMe team.'
              : 'Your page is on TipMe Pro.'}
      </p>
      {pro?.next && (
        <p className="settings-plan__status">
          Next month is paid: Pro until {dateOf(pro.next.endsAt)}.
        </p>
      )}
      {grace && pro?.current && (
        <Slip tone="unsure" title="Your Pro month has ended">
          Pay by {dateOf(pro.current.graceEndsAt)} to keep Pro. After that your
          page goes back to Free; nothing is deleted.
        </Slip>
      )}

      {followed && (
        <FollowedSlip followed={followed} pro={pro} onCheckAgain={checkAgain} />
      )}
      {loadFailed && !pro && (
        <Slip
          tone="error"
          title="We couldn’t load your plan"
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      )}
      {!pro && !loadFailed && <Skeleton label="Loading your plan" />}

      {pro && open?.checkoutUrl && open.status === 'PENDING' && (
        <Slip
          tone="waiting"
          title="You started a payment"
          actions={
            <ActionLink variant="secondary" href={open.checkoutUrl}>
              Continue to payment
            </ActionLink>
          }
        >
          {naira(open.amountMinor)} for one month of Pro, not paid yet.
        </Slip>
      )}

      {pro && canBuy && !following && !open && (
        <div className="settings-plan__buy">
          <p className="settings-plan__price">
            {naira(price!.amountMinor)} a month
          </p>
          <p className="tm-hint">
            Pay by card or bank transfer. You choose which on our payment
            partner’s page.
            {paidMonth && ' You can pay one month ahead.'}
          </p>
          {confirmingBuy ? (
            <div className="settings-plan__confirm">
              <p>
                {naira(price!.amountMinor)} for one month of Pro, from{' '}
                {fromDate}.
              </p>
              <div className="settings-plan__keys">
                <Button
                  variant="continue"
                  aria-busy={busy}
                  disabled={busy}
                  onClick={() => void buy()}
                >
                  Continue to payment
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => setConfirmingBuy(false)}
                >
                  Not now
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="continue" onClick={() => setConfirmingBuy(true)}>
              {buyLabel}
            </Button>
          )}
          {problem && (
            <p className="settings-plan__problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      )}

      <p className="tm-hint">Pro includes:</p>
      <ul className="settings-list">
        <li>
          Pro QR designs, and print formats such as a counter card, poster or
          sticker. Free pages keep the three standard QR looks.
        </li>
        <li>
          Three changes to your handle. Free pages keep the handle they claimed.
        </li>
        <li>
          Every animated cover, in any colour, and you choose how it plays
        </li>
        <li>Your own tip amounts, and the one your page starts on</li>
        <li>Card styles and your signature on your thank-you</li>
        <li>
          Up to 8 links in your own order, one of them featured, including your
          website, Telegram, LinkedIn and more. Free pages show 3.
        </li>
        <li>No “Get your own TipMe page” link at the foot of your page</li>
      </ul>
      <p className="tm-hint">
        Photos and designs are free on every plan, and Free includes three
        animated covers that play once. Pro adds every animated cover in any
        colour, and you choose Slow loop or Plays once.{' '}
        <a href="/pro">More about Pro</a>
      </p>
      {pro && !pro.billingOn && !onPro && (
        <>
          <p className="tm-hint">
            <strong>Pro is coming soon to buy.</strong>{' '}
            {price ? `It will cost ${naira(price.amountMinor)} a month. ` : ''}
            Until then, the TipMe team can turn Pro on for your page, and this
            page will show it when they do.
          </p>
          <ActionLink
            variant="continue"
            href={ASK_FOR_PRO}
            className="settings-plan__ask"
          >
            Ask for Pro
          </ActionLink>
        </>
      )}
    </Card>
  );
}

export function PlanSection() {
  return (
    <SettingsChapter id="plan">
      <ProPlan />
    </SettingsChapter>
  );
}
