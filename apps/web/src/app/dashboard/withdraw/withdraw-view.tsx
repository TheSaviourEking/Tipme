'use client';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  DashboardSummary,
  WithdrawalQuoteResponse,
  WithdrawalRow,
  WithdrawalsPage,
} from '@tipme/contracts';
import { FEE_POLICY_V1 } from '@tipme/domain';
import { Button, InputField, Notice, Skeleton, Surface } from '@tipme/ui';
import { usePanel } from '@/components/dashboard/use-panel';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { formatNaira } from '@/lib/demo-amount';
import { dateOf, dayKey, timeOf } from '@/lib/lagos-time';
import { parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';
import { bankLine } from '@/lib/withdrawal-bank';
import {
  withdrawableNow,
  withdrawRefusal,
  withdrawState,
} from '@/lib/withdraw-state';

/** Read once per visit (review I5): see the panels below. */
const ONCE = { resync: false } as const;

/** Quick amounts, offered only when the balance can cover them with something left over. */
const SHORTCUTS_MINOR = [BigInt(500_000), BigInt(2_000_000)];

const requested = (iso: string) =>
  dayKey(iso) === dayKey(new Date().toISOString())
    ? `Requested today at ${timeOf(iso)}.`
    : `Requested ${dateOf(iso)}.`;

/**
 * What a withdrawal row says, only from the state the API reports. `steps` is how many of the
 * three are filled: requested, sent to our payment partner, paid.
 */
function describe(row: WithdrawalRow) {
  switch (row.state) {
    case 'sent':
      return {
        label: 'Paid',
        tone: 'ok',
        steps: 3,
        note: dateOf(row.paidAt ?? row.requestedAt),
      };
    case 'failed':
      return {
        label: 'Failed',
        tone: 'bad',
        steps: 0,
        note: `${dateOf(row.requestedAt)}. It didn’t go through, so the money is back in your balance.`,
      };
    case 'reversed':
      return {
        label: 'Reversed',
        tone: 'bad',
        steps: 0,
        note: `${dateOf(row.requestedAt)}. The payment was reversed. Your balance shows where the money is.`,
      };
    case 'in_review':
      return {
        label: 'Being checked',
        tone: 'wait',
        steps: 2,
        note: `${requested(row.requestedAt)} Our payment partner is checking it.`,
      };
    case 'processing':
      return {
        label: 'On its way',
        tone: 'wait',
        steps: 2,
        note: `${requested(row.requestedAt)} Sent to our payment partner.`,
      };
    default:
      return {
        label: 'Requested',
        tone: 'wait',
        steps: 1,
        note: `${requested(row.requestedAt)} Waiting to be sent.`,
      };
  }
}

function History({
  rows,
  failed,
  refreshFailed,
  next,
  onMore,
}: {
  rows: WithdrawalRow[] | null;
  failed: boolean;
  refreshFailed: boolean;
  next: string | null;
  onMore: () => void;
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
              <li key={row.payoutId} className="withdraw__row" data-open={open}>
                <div className="withdraw__row-head">
                  <strong>{formatNaira(row.amountMinor)}</strong>
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
                {bankLine(row.bank) && (
                  <p className="tm-hint">{bankLine(row.bank)}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rows !== null && refreshFailed && (
        <p role="status" className="tm-hint">
          We couldn’t refresh this list. What you see may be out of date.
        </p>
      )}
      {next && (
        <Button variant="secondary" onClick={onMore}>
          Show more
        </Button>
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
  // Read once per visit, as before live updates (review I5): the quote asks the payment partner
  // for its balance, so no resync, safety refresh or fallback poll may repeat it. PR 2 (Task 14)
  // decides which signals re-read these, behind a shared server cache of that balance.
  const balance = usePanel<DashboardSummary>('/v1/me/dashboard', ONCE);
  const latest = usePanel<WithdrawalQuoteResponse>(
    '/v1/me/withdrawal-quote',
    ONCE,
  );
  const firstPath = '/v1/me/withdrawals';
  const withdrawalsPanel = usePanel<WithdrawalsPage>(firstPath, ONCE);
  // Later pages, kept with the list they belong to: a reload starts from the first page again.
  const [more, setMore] = useState<{
    source: WithdrawalsPage;
    items: WithdrawalRow[];
    next: string | null;
  } | null>(null);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per request, so a double tap never withdraws twice.
  const key = useRef<string | null>(null);
  const reloadAll = () =>
    void Promise.all([
      balance.reload(),
      latest.reload(),
      withdrawalsPanel.reload(),
    ]);

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
      setDone(formatNaira(amount));
      setRaw('');
      key.current = null;
      reloadAll();
      return;
    }
    const refusal = withdrawRefusal(result.code);
    // Refused before anything was recorded, so a new key is safe.
    if (refusal.message === null) key.current = null;
    if (refusal.reload) void Promise.all([balance.reload(), latest.reload()]);
    if (refusal.message) setError(refusal.message);
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
  const withdrawable = withdrawableNow({
    availableMinor: summary.availableMinor,
    withdrawalsAvailable: summary.withdrawalsAvailable,
    quote,
  });
  const chosen = amount === null ? null : BigInt(amount);
  // Tapping the amount already chosen changes nothing: the request key and any warning stay.
  // Only a different amount starts a new request. (Typing is different: onChange starts a new
  // request on any change of the text, even to the same amount.)
  const choose = (minor: bigint) => {
    setRaw(formatNaira(minor));
    if (chosen === minor) return;
    setError('');
    key.current = null;
  };
  const shortcuts = SHORTCUTS_MINOR.filter((minor) => minor < withdrawable);
  // The extra pages belong to the first page they followed; a fresh first page drops them.
  const extra = more && more.source === withdrawalsPanel.data ? more : null;
  const withdrawals = withdrawalsPanel.data
    ? [...withdrawalsPanel.data.items, ...(extra?.items ?? [])]
    : null;
  const nextWithdrawals = extra
    ? extra.next
    : (withdrawalsPanel.data?.nextCursor ?? null);
  const showMoreWithdrawals = async () => {
    const source = withdrawalsPanel.data;
    if (!source || !nextWithdrawals) return;
    const result = await apiFetch<WithdrawalsPage>(
      `${firstPath}?cursor=${encodeURIComponent(nextWithdrawals)}`,
    );
    if (result.ok)
      setMore({
        source,
        items: [...(extra?.items ?? []), ...result.data.items],
        next: result.data.nextCursor,
      });
  };
  const smallest = formatNaira(FEE_POLICY_V1.minWithdrawalMinor);
  // Only an amount the server would accept gets figures: within what can be withdrawn, and at
  // least the minimum unless it is all of it.
  const sendable =
    chosen !== null &&
    chosen <= withdrawable &&
    (chosen >= FEE_POLICY_V1.minWithdrawalMinor || chosen === withdrawable);
  // Withdrawing is free: TipMe pays the payout's transfer fee (the terms; buildPayoutFeePosting
  // books it as TipMe's expense). The quote's feeMinor is that TipMe-paid cost, never taken from
  // the recipient, so what arrives is the amount asked for.
  const covered = sendable;
  return (
    <div className="dashboard-section withdraw">
      <h1>Withdraw</h1>
      <p>
        Available: <strong>{formatNaira(summary.availableMinor)}</strong>
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
                      {formatNaira(minor)}
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
                      {covered ? formatNaira(chosen) : '—'}
                    </dd>
                    <dt>Balance afterwards</dt>
                    <dd data-testid="balance-afterwards">
                      {covered ? formatNaira(available - chosen) : '—'}
                    </dd>
                  </dl>
                </section>
              )}
              <Button
                type="submit"
                variant="continue"
                disabled={
                  busy || !state.canWithdraw || (amount !== null && !sendable)
                }
                aria-busy={busy}
              >
                {amount ? `Withdraw ${formatNaira(amount)}` : 'Withdraw'}
              </Button>
              <p className="tm-hint">
                Once sent, a withdrawal can’t be cancelled. The smallest
                withdrawal is {smallest}, or your whole balance if it’s less.
              </p>
            </form>
          </Surface>
        )}
        <History
          rows={withdrawals}
          failed={withdrawalsPanel.error === 'load'}
          refreshFailed={withdrawalsPanel.error === 'refresh'}
          next={nextWithdrawals}
          onMore={() => void showMoreWithdrawals()}
        />
      </div>
    </div>
  );
}
