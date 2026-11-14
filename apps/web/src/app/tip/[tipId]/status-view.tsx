'use client';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { firstNameOf, type TipStatusView } from '@tipme/contracts';
import { ActionLink, Button, Card, Skeleton, Slip, Surface } from '@tipme/ui';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { tipStatus } from '@/lib/api-client';
import { ThanksSlip } from '@/components/thanks-slip';
import { AvatarImage } from '@/components/avatar';
import { hasAvatar } from '@/lib/avatar-source';
import { BusinessNote } from './business-note';
import { formatNaira } from '@/lib/demo-amount';
import { readPendingTip, statusTokenKey } from '@/lib/pending-tip';
import { nextCheckDelay } from '@/lib/status-polling';
import { forgetSupporterKeys } from '@/lib/supporter-keys';
import { RecognitionChoice } from './recognition-choice';
import { onReconnect } from '@/lib/connection';
import { CONNECTION_COPY } from '@/lib/connection-copy';
import { useOnline } from '@/components/use-online';
import {
  forgetMyTips,
  recognitionMessage,
  rememberTip,
} from '@/lib/recognition';

type Screen =
  | { kind: 'loading' }
  | { kind: 'incomplete' }
  | { kind: 'not-found' }
  | { kind: 'tip'; view: TipStatusView };

const FINAL = new Set(['paid', 'declined', 'cancelled']);

/** The receipt token: from the #t= fragment, else from this tab's session. Null when absent. */
function currentToken(tipId: string): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) return fromHash;
  try {
    return sessionStorage.getItem(statusTokenKey(tipId));
  } catch {
    return null;
  }
}
const noSubscription = () => () => undefined;

export function StatusView({ pilotNotice }: { pilotNotice?: ReactNode }) {
  const { tipId } = useParams<{ tipId: string }>();
  const copy = paymentModeCopy(usePaymentMode());
  // undefined while rendering on the server (loading), null when the link has no token.
  const token = useSyncExternalStore(
    noSubscription,
    () => currentToken(tipId),
    () => undefined,
  );
  const [result, setResult] = useState<Screen>({ kind: 'loading' });
  // Online but the API didn't answer; told apart from the browser being offline (Task 16).
  const [noAnswer, setNoAnswer] = useState(false);
  const online = useOnline();
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const [celebration, setCelebration] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [copied, setCopied] = useState(false);
  const celebrated = useRef(false);
  const screen: Screen = token === null ? { kind: 'incomplete' } : result;

  // Keep the token for this tab, then take it out of the address bar (and history).
  useEffect(() => {
    if (!token || !location.hash) return;
    try {
      sessionStorage.setItem(statusTokenKey(tipId), token);
      history.replaceState(null, '', location.pathname);
    } catch {
      // Without session storage the fragment stays: it is the only copy of the token.
    }
  }, [tipId, token]);

  // Celebrate once, only for a verified paid tip, only if the supporter opted in on this device.
  const celebrate = (view: TipStatusView) => {
    if (celebrated.current) return;
    celebrated.current = true;
    let pending: ReturnType<typeof readPendingTip> = {
      optIn: false,
      handle: null,
      business: null,
    };
    try {
      pending = readPendingTip(sessionStorage, tipId);
    } catch {
      // No session storage: no opt-in to honour.
    }
    if (!pending.optIn) return;
    let storage: Storage | undefined;
    try {
      storage = localStorage;
    } catch {
      storage = undefined;
    }
    const totals = rememberTip(storage, {
      id: tipId,
      handle: view.recipient.handle,
      at: view.completedAt ?? new Date().toISOString(),
      // Made at a business: the next visit there offers this person first (M8).
      ...(pending.business ? { business: pending.business } : {}),
    });
    setCelebration(recognitionMessage(totals));
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async (attempt: number) => {
      timer = undefined;
      const result = await tipStatus(tipId, token);
      if (cancelled) return;
      if (result.ok) {
        setNoAnswer(false);
        setResult({ kind: 'tip', view: result.data });
        if (result.data.state === 'paid') celebrate(result.data);
        if (FINAL.has(result.data.state)) return;
      } else if (result.status === 404) {
        setResult({ kind: 'not-found' });
        return;
      } else {
        setNoAnswer(true);
      }
      const delay = nextCheckDelay(attempt, Date.now() - started);
      if (delay === null) {
        setStopped(true);
        return;
      }
      next = attempt + 1;
      timer = setTimeout(() => void poll(next), delay);
    };
    // Back online: check at once instead of waiting out the timer.
    let next = 0;
    let disarm = () => {};
    const arm = () => {
      disarm = onReconnect(window, () => {
        arm();
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        void poll(next);
      });
    };
    arm();
    void poll(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      disarm();
    };
    // celebrate only reads refs and storage; polling restarts on the token or "Check again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipId, token, round]);

  const copyReceipt = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/tip/${tipId}#t=${token}`,
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const forget = () => {
    try {
      forgetMyTips(localStorage);
      // Only this browser's copy: a recipient keeps seeing past tips grouped until the supporter
      // uses "Stop {name} recognising me".
      forgetSupporterKeys(localStorage);
    } catch {
      // Nothing stored.
    }
    setCelebration(null);
    setForgotten(true);
  };

  const checkAgain = () => {
    setStopped(false);
    setRound((n) => n + 1);
  };
  if (screen.kind === 'loading' && (noAnswer || stopped))
    return (
      <Card className="tip-status-card">
        <h1>We can’t reach TipMe right now</h1>
        <p>
          Your tip is safe to check later: nothing changes while we can’t see
          it. Check your connection, then try again.
        </p>
        <div className="tip-status-actions">
          <Button onClick={checkAgain}>Check again</Button>
        </div>
      </Card>
    );
  if (screen.kind === 'loading') return <Skeleton label="Loading your tip" />;
  if (screen.kind === 'incomplete')
    return (
      <Card className="tip-status-card">
        <h1>This receipt link is incomplete</h1>
        <p>
          The private part of the link is missing, so we can’t show this tip.
          Open the full receipt link you copied, or use the same browser tab you
          tipped from.
        </p>
        <Link href="/">Go to TipMe</Link>
      </Card>
    );
  if (screen.kind === 'not-found')
    return (
      <Card className="tip-status-card">
        <h1>We couldn’t find this tip</h1>
        <p>The receipt link may be incomplete or mistyped.</p>
        <Link href="/">Go to TipMe</Link>
      </Card>
    );

  const { view: tip } = screen;
  const name = tip.recipient.displayName;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '';
  // Their photo when the API sends one (only while it is public), else their initial.
  const photo = tip.recipient.avatarPath;
  const amount = formatNaira(Number(tip.amountMinor));
  const profile = `/@${tip.recipient.handle}`;
  const paid = tip.state === 'paid';
  const retry = tip.state === 'declined' || tip.state === 'cancelled';

  const notices = (
    <>
      {forgotten && (
        <p className="tm-hint" role="status">
          Forgotten. This phone no longer remembers your tips or keys.
        </p>
      )}
      {(noAnswer || (!online && !FINAL.has(tip.state))) && (
        <Slip tone="error" title="Connection lost">
          {online
            ? CONNECTION_COPY.receiptNoAnswer
            : CONNECTION_COPY.receiptOffline}
        </Slip>
      )}
      {stopped && !FINAL.has(tip.state) && (
        <div className="tip-status-actions">
          <p>
            This is taking longer than usual. Keep your receipt link and check
            back later.
          </p>
          <Button variant="secondary" onClick={checkAgain}>
            Check again
          </Button>
        </div>
      )}
    </>
  );

  // One tree for every state, so the live region below stays mounted from waiting to paid,
  // declined or expired and only its words change: a region inserted together with its text is
  // often not announced. Only a payment the API reports as paid gets the moment, then the receipt.
  return (
    <Surface
      material={paid ? 'canvas' : 'instrument'}
      className={
        paid
          ? 'tip-thanks tm-celebration'
          : `tip-status-card tip-status-card--${tip.state}`
      }
    >
      {copy.receiptBanner && (
        <p className="tip-status-pretend">{copy.receiptBanner}</p>
      )}
      {paid ? (
        <div className="tip-thanks__mark" aria-hidden="true">
          {hasAvatar(photo) ? (
            <AvatarImage
              className="tip-thanks__initial tip-thanks__photo"
              src={photo}
              name={name}
              width={132}
              height={132}
              sizes="132px"
            />
          ) : (
            <span className="tip-thanks__initial">{initial}</span>
          )}
          <span className="tip-thanks__tick">✓</span>
        </div>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        className="tip-status-live"
        data-status-live
      >
        {tip.state === 'waiting' && (
          <>
            <span className="tm-pulse" data-pulse aria-hidden="true" />
            <h1>Checking your payment</h1>
            <p>
              This usually takes a moment. We’ll show you as soon as it’s
              confirmed.
            </p>
          </>
        )}
        {tip.state === 'checking' && (
          <>
            <span className="tm-pulse" data-pulse aria-hidden="true" />
            <h1>Still checking</h1>
            <p>
              Our payment partner hasn’t confirmed your {amount} tip yet. We
              keep checking, and we only show success once it’s confirmed.
            </p>
          </>
        )}
        {tip.state === 'collected' && (
          <>
            {/* Not the paid styling: the tip is not confirmed until the details are final. */}
            <h1>Your payment went through</h1>
            <p>
              Our payment partner has taken your {amount}. We’re confirming the
              final details with them, and this receipt will show the tip as
              complete once that’s done. You don’t need to pay again.
            </p>
          </>
        )}
        {paid && (
          <>
            <h1>{name} got your tip.</h1>
            <p>{amount}, confirmed by our payment partner.</p>
          </>
        )}
        {tip.state === 'declined' && (
          <>
            <h1>This payment didn’t go through</h1>
            <p>
              Your tip to {name} wasn’t sent. You can try again with another
              card or bank.
            </p>
          </>
        )}
        {tip.state === 'cancelled' && (
          <>
            <h1>This tip expired</h1>
            <p>
              It wasn’t confirmed in time, so it was cancelled. If money left
              your account anyway, keep this receipt link and contact TipMe.
            </p>
          </>
        )}
      </div>
      {/* Outside the live region, so the announcement stays short. Older APIs send no line. */}
      {paid && tip.thanks && <ThanksSlip slip={tip.thanks} />}
      {/* PR B5: a paid tip made at a business may take a kind note. Outside the live region, after
          the thanks; the receipt below never waits on it. */}
      {paid && token && tip.businessNote?.open && !tip.businessNote.written && (
        <BusinessNote
          tipId={tipId}
          token={token}
          person={tip.businessNote.person}
          business={tip.businessNote.business}
        />
      )}
      {paid ? (
        <Surface
          material="paper"
          className="tip-thanks__receipt"
          role="region"
          aria-labelledby="receipt-title"
        >
          <h2 id="receipt-title">Your receipt</h2>
          <dl>
            <dt>Your tip</dt>
            <dd>{amount}</dd>
            {tip.reference && (
              <>
                <dt>Reference</dt>
                <dd>{tip.reference}</dd>
              </>
            )}
          </dl>
          {pilotNotice}
          {celebration && (
            <aside className="tip-recognition" aria-label="Your tips">
              <span aria-hidden="true">✳</span>
              <p>{celebration}</p>
            </aside>
          )}
          <Button variant="secondary" onClick={() => void copyReceipt()}>
            {copied ? 'Receipt link copied' : 'Copy receipt link'}
          </Button>
          <ActionLink variant="continue" href={profile}>
            Done
          </ActionLink>
          {/* The supporter's choices about this tip. Older APIs send no `recognised`. */}
          {tip.recognised && token && (
            <section className="tip-choices" aria-label="Your choices">
              <RecognitionChoice
                tipId={tipId}
                token={token}
                handle={tip.recipient.handle}
                name={firstNameOf(name)}
              />
            </section>
          )}
          {(celebration || tip.recognised) && !forgotten && (
            <Button variant="quiet" onClick={forget}>
              Forget my tips and keys on this phone
            </Button>
          )}
        </Surface>
      ) : null}
      {paid ? (
        <>
          {notices}
          <Link className="tip-thanks__own" href="/sign-up">
            Know someone who deserves a tip too? Get your own TipMe page
          </Link>
        </>
      ) : (
        // Beside the live region on a desktop (R1), under it on a phone: the figures the page
        // already has, then the next steps. A wrapper only; the live region above never moves.
        <div className="tip-status-side">
          {tip.state === 'declined' && (
            // Decoration: the heading says it, so screen readers skip the stamp.
            <span
              className="tm-slip__stamp tm-slip__stamp--red tip-status-stamp"
              aria-hidden="true"
            >
              Not
              <br />
              sent
            </span>
          )}
          <p className="tip-status-amount">{amount}</p>
          {tip.reference && (
            <p className="tip-status-ref">Reference {tip.reference}</p>
          )}
          {pilotNotice}
          {notices}
          <div className="tip-status-actions">
            {retry && (
              <ActionLink variant="continue" href={profile}>
                Try again
              </ActionLink>
            )}
            <Button variant="secondary" onClick={() => void copyReceipt()}>
              {copied ? 'Receipt link copied' : 'Copy receipt link'}
            </Button>
          </div>
        </div>
      )}
    </Surface>
  );
}
