'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DashboardSummary } from '@tipme/contracts';
import { Button, InputField, Notice, Skeleton } from '@tipme/ui';
import { naira, parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';

export default function WithdrawPage() {
  const id = useId();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per request, so a double tap never withdraws twice.
  const key = useRef<string | null>(null);

  useEffect(() => {
    void apiFetch<DashboardSummary>('/v1/me/dashboard').then((result) => {
      if (result.ok) setSummary(result.data);
    });
  }, [done]);

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
    setError(
      result.code === 'INSUFFICIENT_BALANCE'
        ? 'That is more than your available balance.'
        : result.code === 'WITHDRAWAL_TOO_SMALL'
          ? 'The smallest withdrawal is NGN 1,000.'
          : 'We couldn’t request the withdrawal. Please try again.',
    );
  };

  if (!summary) return <Skeleton label="Loading your balance" />;
  return (
    <div className="dashboard-section withdraw">
      <h1>Withdraw</h1>
      <p>
        Available: <strong>{naira(summary.availableMinor)}</strong>
      </p>
      <Notice title="Pretend withdrawal">
        No real money moves during the preview. The pretend bank pays straight
        away.
      </Notice>
      {done && (
        <Notice tone="success" title="Withdrawal requested">
          {done} is on its way to your pretend bank.{' '}
          <Link href="/dashboard">Back to your dashboard</Link>
        </Notice>
      )}
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
          disabled={busy || summary.availableMinor === '0'}
          aria-busy={busy}
        >
          {amount ? `Withdraw ${naira(amount)}` : 'Withdraw'}
        </Button>
      </form>
    </div>
  );
}
