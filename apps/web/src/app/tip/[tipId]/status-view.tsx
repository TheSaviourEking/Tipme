'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { TipStatusView } from '@tipme/contracts';
import { Button, Card, Notice, Skeleton } from '@tipme/ui';
import { tipStatus } from '@/lib/api-client';
import { formatDemoAmount } from '@/lib/demo-amount';
import { readPendingTip, statusTokenKey } from '@/lib/pending-tip';
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
const GIVE_UP_AFTER_MS = 2 * 60 * 1000;
/** 1 s for the first ten checks, then 2 s, then 5 s after half a minute. */
const delayFor = (attempt: number, elapsedMs: number) =>
  attempt < 10 ? 1000 : elapsedMs < 30_000 ? 2000 : 5000;

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

export function StatusView() {
  const { tipId } = useParams<{ tipId: string }>();
  // undefined while rendering on the server (loading), null when the link has no token.
  const token = useSyncExternalStore(
    noSubscription,
    () => currentToken(tipId),
    () => undefined,
  );
  const [result, setResult] = useState<Screen>({ kind: 'loading' });
  const [offline, setOffline] = useState(false);
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
    let pending = { optIn: false, handle: null as string | null };
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
    });
    setCelebration(recognitionMessage(totals));
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async (attempt: number) => {
      const result = await tipStatus(tipId, token);
      if (cancelled) return;
      if (result.ok) {
        setOffline(false);
        setResult({ kind: 'tip', view: result.data });
        if (result.data.state === 'paid') celebrate(result.data);
        if (FINAL.has(result.data.state)) return;
      } else if (result.status === 404) {
        setResult({ kind: 'not-found' });
        return;
      } else {
        setOffline(true);
      }
      const elapsed = Date.now() - started;
      if (elapsed >= GIVE_UP_AFTER_MS) {
        setStopped(true);
        return;
      }
      timer = setTimeout(
        () => void poll(attempt + 1),
        delayFor(attempt, elapsed),
      );
    };
    void poll(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
  if (screen.kind === 'loading' && (offline || stopped))
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
  const amount = formatDemoAmount(Number(tip.amountMinor));
  const profile = `/@${tip.recipient.handle}`;
  return (
    <Card className={`tip-status-card tip-status-card--${tip.state}`}>
      <p className="tip-status-pretend">Test payment · no real money moved</p>
      <div role="status" aria-live="polite" className="tip-status-live">
        {tip.state === 'waiting' && (
          <>
            <span className="tip-status-icon" aria-hidden="true">
              ◌
            </span>
            <h1>Waiting for confirmation…</h1>
            <p>
              {amount} for {name}. We’re waiting for the payment provider to
              confirm it.
            </p>
          </>
        )}
        {tip.state === 'checking' && (
          <>
            <span className="tip-status-icon" aria-hidden="true">
              ◌
            </span>
            <h1>Still checking</h1>
            <p>
              The payment provider hasn’t confirmed your {amount} tip yet. We
              keep checking, and we only show success once it’s confirmed.
            </p>
          </>
        )}
        {tip.state === 'paid' && (
          <>
            <span
              className="tip-status-icon tip-status-icon--paid"
              aria-hidden="true"
            >
              ✓
            </span>
            <h1>Paid. {name} got your thanks.</h1>
            <p>{amount} · confirmed by the payment provider.</p>
          </>
        )}
        {tip.state === 'declined' && (
          <>
            <h1>The payment was declined</h1>
            <p>Nothing was charged. You can try again whenever you like.</p>
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
      {tip.state === 'paid' && celebration && (
        <aside className="tip-recognition" aria-label="Your tips">
          <span aria-hidden="true">✳</span>
          <p>{celebration}</p>
        </aside>
      )}
      {forgotten && (
        <p className="tm-hint" role="status">
          Forgotten. This phone no longer remembers your tips.
        </p>
      )}
      {offline && (
        <Notice tone="error" title="Connection lost">
          We’ll keep trying to reach TipMe.
        </Notice>
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
      <div className="tip-status-actions">
        {(tip.state === 'declined' || tip.state === 'cancelled') && (
          <Link className="tm-button tm-button--primary" href={profile}>
            Try again
          </Link>
        )}
        {tip.state === 'paid' && (
          <Link className="tm-button tm-button--primary" href={profile}>
            Done
          </Link>
        )}
        <Button variant="secondary" onClick={() => void copyReceipt()}>
          {copied ? 'Receipt link copied' : 'Copy receipt link'}
        </Button>
        {celebration && (
          <Button variant="quiet" onClick={forget}>
            Forget my tips on this phone
          </Button>
        )}
      </div>
    </Card>
  );
}
