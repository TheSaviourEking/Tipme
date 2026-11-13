'use client';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  DashboardSummary,
  WithdrawalRow,
  WithdrawalsPage,
} from '@tipme/contracts';
import { CURRENT_FEE_POLICY } from '@tipme/domain';
import {
  Button,
  InputField,
  Lamp,
  Skeleton,
  Slip,
  Stamp,
  StandingWarning,
  Steps,
  Surface,
} from '@tipme/ui';
import type { StampTone } from '@tipme/ui';
import { usePanel } from '@/components/dashboard/use-panel';
import { useWithdrawalQuote } from '@/components/dashboard/use-withdrawal-quote';
import { useWithdrawalInFlight } from '@/components/live/live-provider';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { formatNaira } from '@/lib/demo-amount';
import { dateOf, dayKey, timeOf } from '@/lib/lagos-time';
import { parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';
import { bankLine } from '@/lib/withdrawal-bank';
import { withdrawalInFlight } from '@/lib/quote-merge';
import {
  belowMinimum,
  TOO_SMALL,
  withdrawableNow,
  withdrawFee,
  withdrawSummary,
  withdrawLamp,
  withdrawRefusal,
  withdrawState,
  withdrawUnsure,
} from '@/lib/withdraw-state';

/**
 * Re-read on a withdrawal change or a tip (live updates, PR 2), but never on a resync, a tab focus
 * or the fallback poll: the page reads once per visit as before (review I5). None of these reads
 * asks the payment partner; the quote has its own rule (use-withdrawal-quote.ts).
 */
const LIVE = {
  live: ['withdrawals.changed', 'tips.changed'],
  resync: false,
} as const;

/** Quick amounts, offered only when the balance can cover them with something left over. */
const SHORTCUTS_MINOR = [BigInt(500_000), BigInt(2_000_000)];

const requested = (iso: string) =>
  dayKey(iso) === dayKey(new Date().toISOString())
    ? `Requested today at ${timeOf(iso)}.`
    : `Requested ${dateOf(iso)}.`;

/** The three steps a withdrawal's lamps light, one by one, from the API's state only. */
const STEPS = ['Requested', 'Sent to our payment partner', 'Paid'] as const;

/**
 * What a withdrawal row says, only from the state the API reports. `stamp` is the tone of the
 * row's stamp; `steps` is how many of the three STEPS are filled.
 */
function describe(row: WithdrawalRow): {
  label: string;
  stamp: StampTone;
  steps: number;
  note: string;
} {
  switch (row.state) {
    case 'sent':
      return {
        label: 'Paid',
        stamp: 'ok',
        steps: 3,
        note: dateOf(row.paidAt ?? row.requestedAt),
      };
    case 'failed':
      return {
        label: 'Failed',
        stamp: 'bad',
        steps: 0,
        note: `${dateOf(row.requestedAt)}. It didn’t go through, so the money is back in your balance.`,
      };
    case 'reversed':
      return {
        label: 'Reversed',
        stamp: 'bad',
        steps: 0,
        note: `${dateOf(row.requestedAt)}. The payment was reversed. Your balance shows where the money is.`,
      };
    case 'in_review':
      return {
        label: 'Being checked',
        stamp: 'wait',
        steps: 2,
        note: `${requested(row.requestedAt)} Our payment partner is checking it.`,
      };
    case 'processing':
      return {
        label: 'On its way',
        stamp: 'wait',
        steps: 2,
        note: `${requested(row.requestedAt)} Sent to our payment partner.`,
      };
    default:
      return {
        label: 'Requested',
        stamp: 'wait',
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
        <ol className="withdraw__rows">
          {rows.map((row) => {
            const view = describe(row);
            const open = view.steps > 0 && view.steps < 3;
            const bank = bankLine(row.bank);
            // History, not news: a row has no live role, so nothing here is announced.
            return (
              <li key={row.payoutId} className="withdraw__row" data-open={open}>
                <span className="withdraw__amount">
                  {formatNaira(row.amountMinor)}
                </span>
                <Stamp tone={view.stamp}>{view.label}</Stamp>
                {open && (
                  <Steps
                    className="withdraw__steps"
                    labels={STEPS}
                    filled={view.steps}
                  />
                )}
                <p className="withdraw__note">{view.note}</p>
                {/* Proven: a failed payout is released and its amount no longer reserved
                    (withdraw-and-audit plan, money-safety proofs). Only on a row the API reports failed. */}
                {row.state === 'failed' && (
                  <p className="withdraw__back">
                    Back in your balance: {formatNaira(row.amountMinor)}
                  </p>
                )}
                {bank && <p className="withdraw__bank">{bank}</p>}
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
        <Button variant="secondary" className="withdraw__more" onClick={onMore}>
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
  const balance = usePanel<DashboardSummary>('/v1/me/dashboard', LIVE);
  // The full quote asks the payment partner: once per visit and on the person's own action. A
  // withdrawal change re-reads only TipMe's side of it. A tip doesn't change what the partner
  // allows until it settles there, so the quote stays as read (the request is checked fresh).
  const latest = useWithdrawalQuote(['withdrawals.changed']);
  const firstPath = '/v1/me/withdrawals';
  const withdrawalsPanel = usePanel<WithdrawalsPage>(firstPath, LIVE);
  // One of theirs on its way: its signals are re-read at once, not after the broadcast spread.
  useWithdrawalInFlight(() => withdrawalInFlight(withdrawalsPanel.data?.items));
  // Later pages, kept with the list they belong to: a reload starts from the first page again.
  const [more, setMore] = useState<{
    source: WithdrawalsPage;
    items: WithdrawalRow[];
    next: string | null;
  } | null>(null);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  // Whether the amount has been checked against the minimum: on leaving the field or a submit
  // attempt, never per keystroke, so typing "1", "15", "150" announces nothing.
  const [checked, setChecked] = useState(false);
  // A refusal that may have followed a request that arrived: said on a slip, not at the field.
  const [unsure, setUnsure] = useState<{ title: string; body: string } | null>(
    null,
  );
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
  const summary = balance.data;
  if (balance.error === 'load')
    return (
      <Slip tone="error" title="We couldn’t load your balance">
        Please reload the page.
      </Slip>
    );
  // A quote that failed to refresh is no quote: it is never read as a yes.
  if (!summary || (!latest.data && !latest.error && !latest.needsCheck))
    return <Skeleton label="Loading your balance" />;
  const quote = latest.error ? null : latest.data;
  const state = withdrawState({
    withdrawalsAvailable: summary.withdrawalsAvailable,
    quote,
    needsCheck: latest.needsCheck,
  });
  const ready = quote?.state === 'ready' ? quote : null;
  const available = BigInt(summary.availableMinor);
  // The most that can go now: the balance, and no more than the quote allows. Never pending money.
  const withdrawable = withdrawableNow({
    availableMinor: summary.availableMinor,
    withdrawalsAvailable: summary.withdrawalsAvailable,
    quote,
    needsCheck: latest.needsCheck,
  });
  const chosen = amount === null ? null : BigInt(amount);
  // Only while a withdrawal could go: with nothing to withdraw, the instrument already says why.
  const tooSmall = state.canWithdraw && belowMinimum(chosen, withdrawable);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!amount) {
      setError('Enter an amount, like 1000 or 1,000.50.');
      return;
    }
    // The server would refuse it: say so at the field. Nothing is sent and the key is untouched.
    if (tooSmall) {
      setChecked(true);
      return;
    }
    setBusy(true);
    setError('');
    setUnsure(null);
    key.current ??= crypto.randomUUID();
    const sent = key.current;
    const result = await apiFetch<{ payoutId: string }>('/v1/me/withdrawals', {
      method: 'POST',
      body: { amountMinor: String(amount) },
      headers: { 'idempotency-key': sent },
    });
    setBusy(false);
    // The amount changed while this was on its way (typing clears the key): a refusal belongs to
    // the old amount, so it doesn't bring back a slip or an error over the new one. A success still
    // shows below: money that moved is always said.
    const stale = key.current !== sent;
    if (result.ok) {
      // What arrives: the amount less the fee when the user pays it (owner, 12 Nov 2026).
      setDone(formatNaira(figures ? Number(figures.receiveMinor) : amount));
      setRaw('');
      setChecked(false);
      key.current = null;
      reloadAll();
      return;
    }
    const refusal = withdrawRefusal(result.code);
    if (refusal.reload) void Promise.all([balance.reload(), latest.reload()]);
    if (stale) return;
    // Refused before anything was recorded, so a new key is safe.
    if (refusal.message === null) key.current = null;
    const maybeSent = withdrawUnsure(result.code);
    if (maybeSent) setUnsure(maybeSent);
    else if (refusal.message) setError(refusal.message);
  };

  // Tapping the amount already chosen changes nothing: the request key and any warning stay.
  // Only a different amount starts a new request. (Typing is different: onChange starts a new
  // request on any change of the text, even to the same amount.)
  const choose = (minor: bigint) => {
    setRaw(formatNaira(minor));
    if (chosen === minor) return;
    setError('');
    setUnsure(null);
    setChecked(false);
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
  const smallest = formatNaira(CURRENT_FEE_POLICY.minWithdrawalMinor);
  // Only an amount the server would accept gets figures: within what can be withdrawn, and at
  // least the minimum unless it is all of it.
  const sendable =
    chosen !== null &&
    chosen <= withdrawable &&
    (chosen >= CURRENT_FEE_POLICY.minWithdrawalMinor ||
      chosen === withdrawable);
  // Users pay the transfer fee from the amount (owner, 12 Nov 2026): what arrives is the amount
  // less the fee, and the whole amount leaves the balance. Only an amount that sends something
  // gets figures.
  const figures =
    sendable && chosen !== null ? withdrawSummary(quote, chosen) : null;
  const covered = figures !== null;
  const lamp = withdrawLamp(state, withdrawable);
  const feeLine = withdrawFee(quote);
  // Ready with money to send: the lamp line and the bank chip say what the notice used to.
  const readyWithMoney = state.kind === 'ready' && withdrawable > BigInt(0);
  const notice = state.notice;
  const noticeLink = notice.href && notice.linkLabel && (
    <Link href={notice.href}>{notice.linkLabel}</Link>
  );
  return (
    <div className="dashboard-section withdraw">
      <h1>Withdraw</h1>
      {state.place === 'warning' && (
        <StandingWarning title={notice.title} className="withdraw__warning">
          {notice.body}
        </StandingWarning>
      )}
      {done && (
        <Slip
          tone="done"
          title="Withdrawal requested"
          className="withdraw__done"
        >
          {done}
          {copy.withdrawDoneSuffix}{' '}
          <Link href="/dashboard">Back to your dashboard</Link>
        </Slip>
      )}
      <div className="withdraw__layout">
        <div className="withdraw__money">
          <section
            className="withdraw__meter"
            aria-labelledby={`${id}-available`}
          >
            <h2 id={`${id}-available`} className="withdraw__cap">
              Available
            </h2>
            <p className="withdraw__figure" data-testid="withdraw-available">
              {formatNaira(summary.availableMinor)}
            </p>
            <p className="withdraw__lamp">
              <Lamp tone={lamp.tone} />
              {lamp.text}
            </p>
            {readyWithMoney && feeLine && (
              <p className="withdraw__fine">{feeLine}</p>
            )}
            {state.place === 'instrument' && !readyWithMoney && (
              <p className="withdraw__fine">
                {notice.body}
                {noticeLink && <> {noticeLink}</>}
                {state.kind === 'needs_check' && (
                  <>
                    {' '}
                    <Button
                      variant="secondary"
                      onClick={() => void latest.reload()}
                    >
                      Check again
                    </Button>
                  </>
                )}
              </p>
            )}
            {state.review && (
              <p className="withdraw__lamp">
                <Lamp tone="amber" />
                Being checked. {state.review}
              </p>
            )}
            {ready && (
              <p className="withdraw__chip">
                <span>{bankLine(ready.destination)}</span>
                <Link href="/dashboard/settings#get-paid">Change</Link>
              </p>
            )}
            {pilotNotice}
          </section>
          {state.place === 'slip' && (
            <Slip
              tone="neutral"
              stamp={state.stamp}
              title={notice.title}
              actions={
                notice.href &&
                notice.linkLabel && (
                  <Link
                    className="tm-button tm-button--continue"
                    href={notice.href}
                  >
                    {notice.linkLabel}
                  </Link>
                )
              }
            >
              {notice.body}
            </Slip>
          )}
          {unsure && (
            <Slip tone="unsure" stamp={'Not\nconfirmed'} title={unsure.title}>
              {unsure.body}
            </Slip>
          )}
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
                    setUnsure(null);
                    setChecked(false);
                    key.current = null;
                  }}
                  onBlur={() => setChecked(true)}
                  onKeyDown={(event) => {
                    // The Withdraw key is disabled for an amount that can't go, so Enter doesn't
                    // submit: it still checks the amount, as leaving the field does.
                    if (event.key === 'Enter') setChecked(true);
                  }}
                  error={error || (checked && tooSmall ? TOO_SMALL : undefined)}
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
                      <dt>Transfer fee</dt>
                      <dd data-testid="transfer-fee">
                        {figures
                          ? figures.feePaidBy === 'tipme'
                            ? 'Paid by TipMe'
                            : formatNaira(figures.feeMinor)
                          : '—'}
                      </dd>
                      <dt>You’ll receive</dt>
                      <dd data-testid="you-receive">
                        {figures ? formatNaira(figures.receiveMinor) : '—'}
                      </dd>
                      <dt>Balance afterwards</dt>
                      <dd data-testid="balance-afterwards">
                        {covered && chosen !== null
                          ? formatNaira(available - chosen)
                          : '—'}
                      </dd>
                    </dl>
                  </section>
                )}
                <Button
                  type="submit"
                  variant="continue"
                  disabled={
                    busy || !state.canWithdraw || (amount !== null && !covered)
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
        </div>
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
