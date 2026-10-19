'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Notice, Skeleton } from '@tipme/ui';
import { mockCheckoutPay, mockCheckoutSummary } from '@/lib/api-client';
import { formatDemoAmount } from '@/lib/demo-amount';

const outcomes = [
  { outcome: 'succeed', label: 'Pay', hint: 'The payment succeeds.' },
  { outcome: 'decline', label: 'Decline', hint: 'The card is declined.' },
  {
    outcome: 'pending-then-succeed',
    label: 'Slow payment',
    hint: 'Pending first, then succeeds.',
  },
  {
    outcome: 'no-reply',
    label: 'No reply',
    hint: 'Paid, but the provider never tells TipMe.',
  },
  {
    outcome: 'wrong-amount',
    label: 'Wrong amount',
    hint: 'The provider reports a different amount.',
  },
] as const;

const describeFailure = (code: string, status: number) =>
  code === 'TIP_NOT_PAYABLE'
    ? 'This payment has expired and can no longer be paid.'
    : status === 404
      ? 'This payment doesn’t exist.'
      : 'The pretend provider is unavailable. Please try again.';

type Summary = {
  amountMinor: string;
  currency: string;
  recipientDisplayName: string;
};

/** A stand-in for a provider's hosted checkout. Deliberately not TipMe-branded. */
export function MockCheckoutView() {
  const { reference } = useParams<{ reference: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState('');
  const [paying, setPaying] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    void mockCheckoutSummary(reference).then((result) => {
      if (result.ok) {
        setSummary(result.data);
        return;
      }
      setFailed(describeFailure(result.code, result.status));
      // Expired or unknown payments stay that way; only an unreachable provider is worth retrying.
      setRetryable(result.code !== 'TIP_NOT_PAYABLE' && result.status !== 404);
    });
  }, [reference, loads]);

  const pay = async (outcome: string) => {
    setPaying(true);
    const result = await mockCheckoutPay(reference, outcome);
    if (result.ok) {
      location.assign(result.data.returnUrl);
      return;
    }
    setPaying(false);
    setSummary(null);
    setFailed(describeFailure(result.code, result.status));
  };

  return (
    <section className="mock-provider" aria-labelledby="mock-provider-title">
      <p className="mock-provider__label">
        Pretend payment provider · no real money
      </p>
      <h1 id="mock-provider-title">Confirm payment</h1>
      {failed && (
        <Notice tone="error" title="Payment unavailable">
          {failed}
        </Notice>
      )}
      {failed && retryable && !summary && (
        <button
          type="button"
          className="mock-provider__button mock-provider__retry"
          onClick={() => {
            setFailed('');
            setRetryable(false);
            setLoads((n) => n + 1);
          }}
        >
          <strong>Try again</strong>
        </button>
      )}
      {!summary && !failed && <Skeleton label="Loading the payment" />}
      {summary && (
        <>
          <p className="mock-provider__amount">
            {formatDemoAmount(Number(summary.amountMinor))}
          </p>
          <p>To {summary.recipientDisplayName}, via TipMe</p>
          <fieldset className="mock-provider__outcomes" disabled={paying}>
            <legend>Choose what the pretend provider does</legend>
            {outcomes.map(({ outcome, label, hint }) => (
              <button
                key={outcome}
                type="button"
                className="mock-provider__button"
                onClick={() => void pay(outcome)}
              >
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
          </fieldset>
        </>
      )}
    </section>
  );
}
