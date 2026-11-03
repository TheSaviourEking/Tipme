'use client';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  ActivityRow,
  DashboardSummary,
  WithdrawalQuoteResponse,
} from '@tipme/contracts';
import { FEE_POLICY_V1 } from '@tipme/domain';
import { Button, InputField, Notice, Skeleton, Surface } from '@tipme/ui';
import { usePanel } from '@/components/dashboard/use-panel';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { naira, parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';
import { nairaSign, withdrawState } from '@/lib/withdraw-state';

/** Quick amounts, offered only when the balance can cover them with something left over. */
const SHORTCUTS_MINOR = [BigInt(500_000), BigInt(2_000_000)];

const ZONE = 'Africa/Lagos';
const dayKey = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE });
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ZONE,
  });
const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: ZONE,
  });
const requested = (iso: string) =>
  dayKey(iso) === dayKey(new Date().toISOString())
    ? `Requested today at ${timeOf(iso)}.`
    : `Requested ${dateOf(iso)}.`;

/**
 * What a withdrawal row says, only from the state the API reports. `steps` is how many of the
 * three are filled: requested, sent to our payment partner, paid.
 */
function describe(row: ActivityRow) {
  switch (row.state) {
    case 'sent':
      return { label: 'Paid', tone: 'ok', steps: 3, note: dateOf(row.at) };
    case 'failed':
      return {
        label: 'Failed',
        tone: 'bad',
        steps: 0,
        note: `${dateOf(row.at)}. It didn’t go through, so the money is back in your balance.`,
      };
    case 'reversed':
      return {
        label: 'Reversed',
        tone: 'bad',
        steps: 0,
        note: `${dateOf(row.at)}. The payment was reversed. Your balance shows where the money is.`,
      };
    case 'in_review':
      return {
        label: 'Being checked',
        tone: 'wait',
        steps: 2,
        note: `${requested(row.at)} Our payment partner is checking it.`,
      };
    case 'processing':
      return {
        label: 'On its way',
        tone: 'wait',
        steps: 2,
        note: `${requested(row.at)} Sent to our payment partner.`,
      };
    default:
      return {
        label: 'Requested',
        tone: 'wait',
        steps: 1,
        note: `${requested(row.at)} Waiting to be sent.`,
      };
  }
}

function History({
  rows,
  failed,
}: {
  rows: ActivityRow[] | null;
  failed: boolean;
}) {
  return (
    <section className="withdraw__history" aria-labelledby="withdraw-history">
      <h2 id="withdraw-history">Your withdrawals</h2>
      {rows === null ? (
        <p className="tm-hint">
          {failed ? 'We couldn’t load your withdrawals.' : 'Loading…'}
        </p>
      ) : rows.length === 0 ? (
        <p className="tm-hint">Withdrawals you make will be listed here.</p>
      ) : (
        <ol>
          {rows.map((row) => {
            const view = describe(row);
            const open = view.steps > 0 && view.steps < 3;
            return (
              <li key={row.id} className="withdraw__row" data-open={open}>
                <div className="withdraw__row-head">
                  <strong>{nairaSign(row.amountMinor)}</strong>
                  <span
                    className={`withdraw__state withdraw__state--${view.tone}`}
                  >
                    {view.label}
                  </span>
                </div>
                {open && (
                  <ol aria-label="Progress" className="withdraw__steps">
                    {[1, 2, 3].map((step) => (
                      <li key={step} data-filled={step <= view.steps}>
                        <span className="sr-only">
                          Step {step} of 3,{' '}
                          {step <= view.steps ? 'done' : 'not yet'}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                <p>{view.note}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default function WithdrawPage({
  pilotNotice,
}: {
  /** The pilot notice, rendered on the server (null outside live mode). */
  pilotNotice?: ReactNode;
}) {
  const id = useId();
  const copy = paymentModeCopy(usePaymentMode());
  const balance = usePanel<DashboardSummary>('/v1/me/dashboard');
  const latest = usePanel<WithdrawalQuoteResponse>('/v1/me/withdrawal-quote');
  const activity = usePanel<ActivityRow[]>('/v1/me/activity');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per request, so a double tap never withdraws twice.
  const key = useRef<string | null>(null);
  const reloadAll = () =>
    void Promise.all([balance.reload(), latest.reload(), activity.reload()]);

  const amount = parseNaira(raw.replace(/^₦\s*/, '').trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!amount) {
      setError('Enter an amount, like 1000 or 1,000.50.');
      return;
    }
    setBusy(true);
    setError('');
    key.current ??= crypto.randomUUID();
    const result = await apiFetch<{ payoutId: string }>('/v1/me/withdrawals', {
      method: 'POST',
      body: { amountMinor: String(amount) },
      headers: { 'idempotency-key': key.current },
    });
    setBusy(false);
    if (result.ok) {
      setDone(naira(amount));
      setRaw('');
      key.current = null;
      reloadAll();
      return;
    }
    if (
      result.code === 'WITHDRAWALS_PAUSED' ||
      result.code === 'WITHDRAWALS_SWITCHED_OFF' ||
      result.code === 'PAYOUT_SETUP_NEEDED' ||
      result.code === 'PAYOUT_DESTINATION_NEEDED' ||
      result.code === 'PAYOUT_PROVIDER_UNAVAILABLE' ||
      result.code === 'WITHDRAWAL_UNAVAILABLE'
    ) {
      // Refused before anything was recorded, and the page now shows why.
      key.current = null;
      void Promise.all([balance.reload(), latest.reload()]);
      return;
    }
    setError(
      result.code === 'INSUFFICIENT_BALANCE'
        ? 'That is more than your available balance.'
        : result.code === 'WITHDRAWAL_TOO_SMALL'
          ? 'The smallest withdrawal is NGN 2,000.'
          : result.code === 'IDEMPOTENCY_CONFLICT'
            ? 'This withdrawal may already be on its way. Check your dashboard before asking again.'
            : // Any other failure may have followed a request that arrived. The key stays, so the
              // same amount again can't withdraw twice, but it must not read as nothing happened.
              'We couldn’t confirm your withdrawal. Check your dashboard before trying again.',
    );
  };

  const summary = balance.data;
  if (balance.error === 'load')
    return (
      <Notice tone="error" title="We couldn’t load your balance">
        Please reload the page.
      </Notice>
    );
  // A quote that failed to refresh is no quote: it is never read as a yes.
  if (!summary || (!latest.data && !latest.error))
    return <Skeleton label="Loading your balance" />;
  const quote = latest.error ? null : latest.data;
  const state = withdrawState({
    withdrawalsAvailable: summary.withdrawalsAvailable,
    quote,
  });
  const ready = quote?.state === 'ready' ? quote : null;
  const available = BigInt(summary.availableMinor);
  // The most that can go now: the balance, and no more than the quote allows. Never pending money.
  const withdrawable =
    ready && state.canWithdraw
      ? BigInt(ready.withdrawableMinor) < available
        ? BigInt(ready.withdrawableMinor)
        : available
      : BigInt(0);
  const choose = (minor: bigint) => {
    setRaw(nairaSign(minor.toString()));
    setError('');
    key.current = null;
  };
  const chosen = amount === null ? null : BigInt(amount);
  const shortcuts = SHORTCUTS_MINOR.filter((minor) => minor < withdrawable);
  const withdrawals =
    activity.data?.filter((row) => row.kind === 'withdrawal') ?? null;
  const smallest = nairaSign(String(FEE_POLICY_V1.minWithdrawalMinor));
  // Withdrawing is free: TipMe pays the transfer fee (see the terms), so what arrives is the
  // amount asked for. The quote's feeMinor is TipMe's cost, never taken from the recipient.
  const covered = chosen !== null && chosen <= available;
  return (
    <div className="dashboard-section withdraw">
      <h1>Withdraw</h1>
      <p>
        Available: <strong>{naira(summary.availableMinor)}</strong>
      </p>
      {pilotNotice}
      {state.kind !== 'collected_elsewhere' && copy.withdrawNotice && (
        <Notice title="Test withdrawal">{copy.withdrawNotice}</Notice>
      )}
      {/* Said before an amount is typed, not after the owner presses Withdraw. */}
      <Notice title={state.notice.title} tone={state.notice.tone}>
        {state.notice.body}
        {state.notice.href && state.notice.linkLabel && (
          <>
            {' '}
            <Link href={state.notice.href}>{state.notice.linkLabel}</Link>
          </>
        )}
      </Notice>
      {state.review && <Notice title="Being checked">{state.review}</Notice>}
      {done && (
        <Notice tone="success" title="Withdrawal requested">
          {done}
          {copy.withdrawDoneSuffix}{' '}
          <Link href="/dashboard">Back to your dashboard</Link>
        </Notice>
      )}
      <div className="withdraw__layout">
        {state.showForm && (
          <Surface material="instrument" className="withdraw__panel">
            <form className="withdraw__form" onSubmit={submit} noValidate>
              <InputField
                id={`${id}-amount`}
                label="Amount (NGN)"
                inputMode="decimal"
                autoComplete="off"
                value={raw}
                onChange={(event) => {
                  setRaw(event.target.value);
                  setError('');
                  key.current = null;
                }}
                error={error || undefined}
              />
              {withdrawable > BigInt(0) && (
                <div
                  role="group"
                  aria-label="Quick amounts"
                  className="withdraw__keys"
                >
                  {shortcuts.map((minor) => (
                    <button
                      key={minor.toString()}
                      type="button"
                      className="withdraw__key"
                      aria-pressed={chosen === minor}
                      onClick={() => choose(minor)}
                    >
                      {nairaSign(minor.toString())}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="withdraw__key"
                    aria-pressed={chosen === withdrawable}
                    onClick={() => choose(withdrawable)}
                  >
                    Everything
                  </button>
                </div>
              )}
              {ready && (
                <section aria-label="Summary">
                  <dl className="withdraw__summary">
                    <dt>Going to</dt>
                    <dd>
                      {ready.destination.bankName} ••{ready.destination.last4}{' '}
                      <Link href="/dashboard/settings#get-paid">Change</Link>
                    </dd>
                    <dt>You receive</dt>
                    <dd data-testid="you-receive">
                      {covered ? nairaSign(String(chosen)) : '—'}
                    </dd>
                    <dt>Balance afterwards</dt>
                    <dd data-testid="balance-afterwards">
                      {covered
                        ? nairaSign((available - chosen).toString())
                        : '—'}
                    </dd>
                  </dl>
                </section>
              )}
              <Button
                type="submit"
                variant="continue"
                disabled={busy || !state.canWithdraw}
                aria-busy={busy}
              >
                {amount ? `Withdraw ${naira(amount)}` : 'Withdraw'}
              </Button>
              <p className="tm-hint">
                Once sent, a withdrawal can’t be cancelled. The smallest
                withdrawal is {smallest}, or your whole balance if it’s less.
              </p>
            </form>
          </Surface>
        )}
        <History rows={withdrawals} failed={activity.error === 'load'} />
      </div>
    </div>
  );
}
