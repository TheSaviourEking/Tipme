'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  DashboardSummary,
  WithdrawalQuoteResponse,
} from '@tipme/contracts';
import { Button, InputField, Notice, Skeleton } from '@tipme/ui';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { naira, parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';
import { withdrawState } from '@/lib/withdraw-state';

export default function WithdrawPage() {
  const id = useId();
  const copy = paymentModeCopy(usePaymentMode());
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [quote, setQuote] = useState<WithdrawalQuoteResponse | null>(null);
  // Bumped after a refusal that says the page is out of date.
  const [checked, setChecked] = useState(0);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per request, so a double tap never withdraws twice.
  const key = useRef<string | null>(null);

  useEffect(() => {
    void Promise.all([
      apiFetch<DashboardSummary>('/v1/me/dashboard'),
      apiFetch<WithdrawalQuoteResponse>('/v1/me/withdrawal-quote'),
    ]).then(([dashboard, latest]) => {
      if (dashboard.ok) setSummary(dashboard.data);
      setQuote(latest.ok ? latest.data : null);
    });
  }, [done, checked]);

  const amount = parseNaira(raw.trim());
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
      return;
    }
    if (
      result.code === 'WITHDRAWALS_PAUSED' ||
      result.code === 'PAYOUT_SETUP_NEEDED' ||
      result.code === 'PAYOUT_DESTINATION_NEEDED' ||
      result.code === 'PAYOUT_PROVIDER_UNAVAILABLE' ||
      result.code === 'WITHDRAWAL_UNAVAILABLE'
    ) {
      // Refused before anything was recorded, and the page now shows why.
      key.current = null;
      setChecked((count) => count + 1);
      return;
    }
    setError(
      result.code === 'INSUFFICIENT_BALANCE'
        ? 'That is more than your available balance.'
        : result.code === 'WITHDRAWAL_TOO_SMALL'
          ? 'The smallest withdrawal is NGN 1,000.'
          : result.code === 'IDEMPOTENCY_CONFLICT'
            ? 'This withdrawal may already be on its way. Check your dashboard before asking again.'
            : // Any other failure may have followed a request that arrived. The key stays, so the
              // same amount again can't withdraw twice, but it must not read as nothing happened.
              'We couldn’t confirm your withdrawal. Check your dashboard before trying again.',
    );
  };

  if (!summary) return <Skeleton label="Loading your balance" />;
  const state = withdrawState({
    withdrawalsAvailable: summary.withdrawalsAvailable,
    quote,
  });
  return (
    <div className="dashboard-section withdraw">
      <h1>Withdraw</h1>
      <p>
        Available: <strong>{naira(summary.availableMinor)}</strong>
      </p>
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
      {state.showForm && (
        <form className="settings-form" onSubmit={submit} noValidate>
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
            hint="The smallest withdrawal is NGN 1,000."
            error={error || undefined}
          />
          <Button
            type="submit"
            disabled={busy || !state.canWithdraw}
            aria-busy={busy}
          >
            {amount ? `Withdraw ${naira(amount)}` : 'Withdraw'}
          </Button>
        </form>
      )}
    </div>
  );
}
