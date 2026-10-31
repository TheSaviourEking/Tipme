'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  BachsOnboardingResponse,
  BachsPaymentAccountStatus,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { apiFetch } from '@/lib/session-client';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; account: BachsPaymentAccountStatus };

const messageFor = (code: string): string => {
  if (code === 'EMAIL_VERIFICATION_REQUIRED')
    return 'Verify your email address first, then set up test payments.';
  if (code === 'PROVIDER_OUTCOME_UNKNOWN')
    return 'We couldn’t confirm whether your payment account was created. TipMe support will check it. Please don’t try again.';
  return 'We couldn’t reach the payment provider. Please try again in a moment.';
};

/** Sandbox-only: shown when the API runs the Bachs sandbox provider; no real money moves. */
export function PaymentAccountCard() {
  const id = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [country, setCountry] = useState('');
  const [entityType, setEntityType] = useState<'individual' | 'company'>(
    'individual',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { refreshAttention } = useRecipient();

  const refresh = useCallback(async () => {
    const result = await apiFetch<BachsPaymentAccountStatus>(
      '/v1/me/payment-account',
    );
    setLoad(
      result.ok ? { kind: 'ready', account: result.data } : { kind: 'failed' },
    );
    // The dashboard's "needs your attention" notice reads the same account.
    refreshAttention();
  }, [refreshAttention]);

  useEffect(() => {
    const returning =
      new URLSearchParams(location.search).get('payment-account') === 'return';
    void (async () => {
      // Coming back from onboarding: the server re-checks with the provider; the URL proves nothing.
      // Only an account that already exists is re-synced, so a hand-made URL can't create one.
      if (returning) {
        const current = await apiFetch<BachsPaymentAccountStatus>(
          '/v1/me/payment-account',
        );
        if (
          current.ok &&
          (current.data.status === 'ONBOARDING' ||
            current.data.status === 'RESTRICTED')
        )
          await apiFetch<BachsOnboardingResponse>(
            '/v1/me/payment-account/onboarding',
            {
              method: 'POST',
              body: { country: 'XX', entityType: 'individual' },
            },
          );
        history.replaceState(null, '', location.pathname);
      }
      await refresh();
    })();
  }, [refresh]);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      setError('Enter your two-letter country code, like GB.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch<BachsOnboardingResponse>(
      '/v1/me/payment-account/onboarding',
      { method: 'POST', body: { country: code, entityType } },
    );
    if (!result.ok) {
      setBusy(false);
      setError(messageFor(result.code));
      await refresh();
      return;
    }
    if ('onboardingUrl' in result.data) {
      location.assign(result.data.onboardingUrl);
      return;
    }
    setBusy(false);
    await refresh();
  };

  if (load.kind === 'loading')
    return (
      <Card id="payments" className="settings-section" aria-busy="true">
        <h2>Test payments</h2>
        <p className="tm-hint">Checking your payment account…</p>
      </Card>
    );
  if (load.kind === 'failed')
    return (
      <Card id="payments" className="settings-section">
        <h2>Test payments</h2>
        <Notice tone="error" title="Couldn’t load your payment account">
          Please try again.
        </Notice>
        <Button variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </Card>
    );

  const { account } = load;
  if (!account.enabled) return null;
  const status = account.status;
  const active = status === 'ACTIVE' && account.chargesEnabled;
  const pending = status === 'CREATING' || status === 'UNKNOWN';

  return (
    <Card id="payments" className="settings-section">
      <h2>Test payments</h2>
      <p className="tm-hint">
        Sandbox only: no real money moves. Set up a test payment account so
        supporters can tip you during testing.
      </p>
      {active && (
        <p role="status" className="page-state page-state--live">
          Ready to receive test tips
        </p>
      )}
      {pending && (
        <Notice title="We’re checking your account">
          We couldn’t confirm your payment account yet. TipMe support will check
          it; please don’t start again.
        </Notice>
      )}
      {!active && !pending && (
        <>
          <p role="status">
            {status === 'ONBOARDING' || status === 'RESTRICTED'
              ? 'Finish setting up your payment account to receive tips.'
              : 'Tips can’t be paid until you set up your payment account.'}
          </p>
          {account.requirementsDue.length > 0 && (
            <p className="tm-hint">
              Still needed: {account.requirementsDue.join(', ')}
            </p>
          )}
          {error && (
            <Notice tone="error" title="Not set up">
              {error}
            </Notice>
          )}
          <form onSubmit={start} className="settings-form" noValidate>
            <InputField
              id={`${id}-country`}
              label="Country code"
              maxLength={2}
              autoComplete="country"
              value={country}
              disabled={busy}
              onChange={(event) => setCountry(event.target.value)}
              hint="Two letters, like GB."
            />
            <div className="tm-field">
              <label htmlFor={`${id}-entity`}>Account type</label>
              <select
                id={`${id}-entity`}
                className="tm-input"
                value={entityType}
                disabled={busy}
                onChange={(event) =>
                  setEntityType(
                    event.target.value === 'company' ? 'company' : 'individual',
                  )
                }
              >
                <option value="individual">Individual</option>
                <option value="company">Company</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>
              {busy
                ? 'Opening…'
                : status === 'ONBOARDING' || status === 'RESTRICTED'
                  ? 'Continue setup'
                  : 'Set up test payments'}
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}
