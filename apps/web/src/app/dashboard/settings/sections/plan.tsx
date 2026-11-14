'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MyProfile, MyPro, ProPurchase } from '@tipme/contracts';
import { ActionLink, Button, Card, ProBadge, Skeleton, Slip } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { dateOf } from '@/lib/lagos-time';
import { naira } from '@/lib/money';
import {
  ASK_FOR_PRO,
  forgetPurchase,
  inGrace,
  payFromBalance,
  readMyPro,
  readPurchase,
  rememberPurchase,
  returningPurchase,
  startPurchase,
  turnOffAutoRenew,
} from '@/lib/pro-buy';
import { apiFetch } from '@/lib/session-client';
import { nextCheckDelay } from '@/lib/status-polling';
import { SettingsChapter } from './section';

// Plan (ScreenSettings; ProPage board's Settings line, ProBadge board's Settings Plan).

type Followed =
  // `balance`: a payment from the TipMe balance the partner hasn't answered yet (no checkout).
  | { kind: 'confirming'; purchase: ProPurchase | null; balance?: boolean }
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
  const balanceRef = useRef(false);
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
    const balance = balanceRef.current;
    setFollowed({ kind: 'confirming', purchase: null, balance });
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
      if (result.ok)
        setFollowed({ kind: 'confirming', purchase: result.data, balance });
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

  return {
    followed,
    checkAgain: () => setRound((n) => n + 1),
    /** Follows a balance payment the partner hasn't answered yet, as a return is followed. */
    followBalance: (purchaseId: string) => {
      rememberPurchase(purchaseId);
      balanceRef.current = true;
      setRound((n) => n + 1);
    },
    /** A payment settled in its own answer (from the balance): no read-back needed. */
    settle: (kind: 'paid' | 'failed') => {
      setFollowed({ kind });
      settledRef.current();
    },
  };
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
      if (followed.balance)
        return (
          <Slip tone="waiting" title="We’re checking this payment">
            Our payment partner hasn’t confirmed the payment from your balance
            yet. This page updates by itself, and your plan changes only once
            it’s confirmed.
          </Slip>
        );
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
  const [renew, setRenew] = useState(false);
  const [renewOff, setRenewOff] = useState<'done' | 'failed' | null>(null);
  const renewId = useId();

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

  const { followed, checkAgain, followBalance, settle } =
    useReturnedPurchase(refresh);

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
  // Both behind the server's flags (off by default): with them off the screen is unchanged.
  const balanceOn = Boolean(pro?.methods?.includes('balance'));
  const renewOn = Boolean(pro?.autoRenew?.on);
  const renewOffered = Boolean(pro?.autoRenew?.available) && !renewOn;

  const buy = async () => {
    if (!price) return;
    setBusy(true);
    setProblem('');
    const result = await startPurchase(price.amountMinor, {
      autoRenew: renewOffered && renew,
    });
    if (result.ok) return;
    setBusy(false);
    setConfirmingBuy(false);
    setProblem(result.message);
    if (result.priceChanged) void load();
  };

  const buyFromBalance = async () => {
    if (!price) return;
    setBusy(true);
    setProblem('');
    const result = await payFromBalance(price.amountMinor);
    setBusy(false);
    setConfirmingBuy(false);
    if (!result.ok) {
      setProblem(result.message);
      if (result.priceChanged) void load();
      return;
    }
    const { status, purchaseId } = result.purchase;
    if (status === 'PAID') settle('paid');
    else if (status === 'FAILED') settle('failed');
    else followBalance(purchaseId);
  };

  const stopRenewing = async () => {
    setBusy(true);
    const result = await turnOffAutoRenew();
    setBusy(false);
    if (result.ok) {
      setPro((now) =>
        now
          ? { ...now, autoRenew: { ...now.autoRenew, on: result.data.on } }
          : now,
      );
      setRenewOff('done');
    } else setRenewOff('failed');
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
      {renewOn && (
        <div className="settings-plan__renew">
          <p className="settings-plan__status">
            Renews automatically on your saved card.
          </p>
          <Button
            variant="secondary"
            aria-busy={busy}
            disabled={busy}
            onClick={() => void stopRenewing()}
          >
            Turn off auto-renew
          </Button>
        </div>
      )}
      {renewOff === 'done' && !renewOn && (
        <Slip tone="done" title="Auto-renew is off">
          Your saved card won’t be charged. Your paid month is unchanged, and
          we’ll remind you before it ends.
        </Slip>
      )}
      {renewOff === 'failed' && (
        <Slip tone="error" title="Auto-renew is still on">
          We couldn’t turn it off. Please try again.
        </Slip>
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
            {balanceOn && ' You can also pay from your TipMe balance.'}
            {paidMonth && ' You can pay one month ahead.'}
          </p>
          {confirmingBuy ? (
            <div className="settings-plan__confirm">
              <p>
                {naira(price!.amountMinor)} for one month of Pro, from{' '}
                {fromDate}.
              </p>
              {renewOffered && (
                <div className="tip-remember">
                  <input
                    id={renewId}
                    type="checkbox"
                    checked={renew}
                    aria-describedby={`${renewId}-hint`}
                    disabled={busy}
                    onChange={(e) => setRenew(e.target.checked)}
                  />
                  <span>
                    <label htmlFor={renewId}>
                      Renew automatically on this card
                    </label>
                    <small id={`${renewId}-hint`}>
                      If you pay by card, it’s charged a day before each month
                      ends. You can turn this off here at any time.
                    </small>
                  </span>
                </div>
              )}
              <div className="settings-plan__keys">
                <Button
                  variant="continue"
                  aria-busy={busy}
                  disabled={busy}
                  onClick={() => void buy()}
                >
                  Continue to payment
                </Button>
                {balanceOn && (
                  <Button
                    variant="secondary"
                    aria-busy={busy}
                    disabled={busy}
                    onClick={() => void buyFromBalance()}
                  >
                    Pay {naira(price!.amountMinor)} from your balance
                  </Button>
                )}
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
        <li>
          Earnings analytics: week, month and year, your average tip and your
          best day
        </li>
        <li>
          Campaigns: up to 20 running links, each with its own QR code and
          results. Free pages get 1.
        </li>
        <li>Your monthly recap, a card ready to share</li>
        <li>Priority support: Pro requests are answered first</li>
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
