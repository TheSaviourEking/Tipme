'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  DEFAULT_PAYMENT_COUNTRY,
  PAYMENT_COUNTRIES,
  type BachsOnboardingResponse,
  type BachsPaymentAccountStatus,
  type PaymentCountryCode,
} from '@tipme/contracts';
import { Button, Card, Notice } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { useLiveEvents } from '@/components/live/live-provider';
import { apiFetch } from '@/lib/session-client';

const PAYMENTS_CHANGED = ['payments.changed'] as const;
import {
  needsBankAccount,
  onboardingRequirements,
  requirementWords,
} from '@/lib/owner-attention';
import {
  paymentAccountCopy,
  type PaymentAccountCopy,
} from '@/lib/payment-account-copy';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; account: BachsPaymentAccountStatus };

const messageFor = (code: string, copy: PaymentAccountCopy): string => {
  if (code === 'EMAIL_VERIFICATION_REQUIRED') return copy.verifyEmailFirst;
  if (code === 'COUNTRY_NOT_SUPPORTED')
    return 'Payment accounts can’t be set up in that country yet. Choose a country from the list.';
  if (code === 'PROVIDER_OUTCOME_UNKNOWN')
    return 'We couldn’t confirm whether your payment account was created. TipMe support will check it. Please don’t try again.';
  return 'We couldn’t reach our payment partner. Please try again in a moment.';
};

/**
 * Shown when the API runs Bachs, sandbox or live. Its words follow the account's environment, so
 * a live recipient is never told this is a test.
 */
export function PaymentAccountCard() {
  const id = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [country, setCountry] = useState<PaymentCountryCode>(
    DEFAULT_PAYMENT_COUNTRY,
  );
  const [entityType, setEntityType] = useState<'individual' | 'company'>(
    'individual',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { refreshAttention } = useRecipient();

  const readCard = useCallback(async () => {
    const result = await apiFetch<BachsPaymentAccountStatus>(
      '/v1/me/payment-account',
    );
    setLoad(
      result.ok ? { kind: 'ready', account: result.data } : { kind: 'failed' },
    );
  }, []);
  const refresh = useCallback(async () => {
    await readCard();
    // The dashboard's "needs your attention" notice reads the same account.
    refreshAttention();
  }, [readCard, refreshAttention]);
  // Changed by our payment partner's update or another tab (live updates). The shell re-reads the
  // notice itself, so only the card is read here.
  useLiveEvents(PAYMENTS_CHANGED, readCard, { resync: false });

  useEffect(() => {
    const returning =
      new URLSearchParams(location.search).get('payment-account') === 'return';
    void (async () => {
      // Coming back from onboarding: the server re-checks with the provider; the URL proves nothing.
      // Only an account that already exists is re-synced, so a hand-made URL can't create one. No
      // country is sent: the API then only re-checks, and never creates an account.
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
              body: { entityType: 'individual' },
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
    setBusy(true);
    setError('');
    const result = await apiFetch<BachsOnboardingResponse>(
      '/v1/me/payment-account/onboarding',
      { method: 'POST', body: { country, entityType } },
    );
    if (!result.ok) {
      setBusy(false);
      setError(
        messageFor(
          result.code,
          paymentAccountCopy(
            load.kind === 'ready' ? load.account.environment : null,
          ),
        ),
      );
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
        <h3>{paymentAccountCopy(null).heading}</h3>
        <p className="tm-hint">Checking your payment account…</p>
      </Card>
    );
  if (load.kind === 'failed')
    return (
      <Card id="payments" className="settings-section">
        <h3>{paymentAccountCopy(null).heading}</h3>
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
  const copy = paymentAccountCopy(account.environment);

  return (
    <Card id="payments" className="settings-section">
      <h3>{copy.heading}</h3>
      <p className="tm-hint">{copy.intro}</p>
      {active && (
        <p role="status" className="page-state page-state--live">
          {copy.ready}
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
          {onboardingRequirements(account.requirementsDue).length > 0 && (
            <p className="tm-hint">
              Still needed:{' '}
              {requirementWords(account.requirementsDue).join(', ')}
            </p>
          )}
          {needsBankAccount(account.requirementsDue) && (
            <p className="tm-hint">
              Your bank account goes under <a href="#get-paid">Get paid</a>.
            </p>
          )}
          {error && (
            <Notice tone="error" title="Not set up">
              {error}
            </Notice>
          )}
          <form onSubmit={start} className="settings-form" noValidate>
            <div className="tm-field">
              <label htmlFor={`${id}-country`}>Country</label>
              <select
                id={`${id}-country`}
                className="tm-input"
                autoComplete="country"
                value={country}
                disabled={busy}
                aria-describedby={
                  country === 'NG' ? undefined : `${id}-country-hint`
                }
                onChange={(event) => {
                  const chosen = PAYMENT_COUNTRIES.find(
                    (option) => option.code === event.target.value,
                  );
                  if (chosen) setCountry(chosen.code);
                }}
              >
                {PAYMENT_COUNTRIES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name} — {option.code}
                  </option>
                ))}
              </select>
              {country !== 'NG' && (
                <p id={`${id}-country-hint`} className="tm-hint">
                  TipMe pays out in naira to Nigerian bank accounts for now.
                </p>
              )}
            </div>
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
                  : copy.setUp}
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}
