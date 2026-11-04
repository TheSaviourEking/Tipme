'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  PayoutBank,
  PayoutBankResolveResponse,
  PayoutDestinationState,
  PayoutDestinationView,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

const STATUS_WORDS: Record<PayoutDestinationView['status'], string> = {
  usable: 'Usable',
  pending_review: 'Being checked',
  rejected: 'Rejected',
};

function messageFor(code: string): string {
  switch (code) {
    case 'CODE_INVALID':
      return 'That code isn’t right or has expired. Please check it, or ask for a new one.';
    case 'SIGN_IN_LOCKED':
      return 'Too many wrong codes. Please wait 15 minutes and try again.';
    case 'TOO_MANY_CODES':
    case 'RATE_LIMITED':
      return 'Too many tries. Please wait a while and try again.';
    case 'EMAIL_VERIFICATION_REQUIRED':
      return 'Confirm your email first: we send a code there before saving a bank account.';
    case 'BANK_CHANGE_HELD':
      return 'Your sign-in email changed recently, so your bank account can’t be added or changed yet.';
    case 'PAYOUT_SETUP_NEEDED':
      return 'Set up your payment account first, then add your bank account.';
    case 'PAYOUT_DESTINATION_REFUSED':
      return 'The payment provider couldn’t accept this bank account. Please check the details.';
    default:
      return 'We couldn’t reach the payment provider. Please try again in a moment.';
  }
}

type Step = 'details' | 'code';

/** The bank account withdrawals go to. Adding or changing one takes a code from the owner's email. */
export function GetPaidCard() {
  const id = useId();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'failed' }
    | {
        kind: 'ready';
        destination: PayoutDestinationView | null;
        bankChangesFrom: string | null;
        banks: PayoutBank[];
      }
  >({ kind: 'loading' });
  const [changing, setChanging] = useState(false);
  const [step, setStep] = useState<Step>('details');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resolved, setResolved] = useState<PayoutBankResolveResponse | null>(
    null,
  );
  const [typedName, setTypedName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);

  const load = useCallback(async () => {
    const [destination, banks] = await Promise.all([
      apiFetch<PayoutDestinationState>('/v1/me/payout-destination'),
      apiFetch<PayoutBank[]>('/v1/payout-banks'),
    ]);
    setState(
      destination.ok && banks.ok
        ? {
            kind: 'ready',
            destination: destination.data.destination,
            bankChangesFrom: destination.data.bankChangesFrom,
            banks: banks.data,
          }
        : { kind: 'failed' },
    );
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // This page draws itself after the browser has looked for the anchor, so links to #get-paid
  // (the withdraw page and payout emails) would otherwise land at the top. Instant, so reduced
  // motion needs no special case; again once loaded, as the card's height has changed.
  const loaded = state.kind !== 'loading';
  useEffect(() => {
    if (location.hash === '#get-paid')
      document.getElementById('get-paid')?.scrollIntoView();
  }, [loaded]);

  const resetForm = () => {
    setStep('details');
    setBankCode('');
    setAccountNumber('');
    setResolved(null);
    setTypedName('');
    setCode('');
    setError('');
    setResent(false);
  };

  const accountName =
    resolved?.resolved === true ? resolved.accountName : typedName.trim();

  const lookUp = async () => {
    if (!bankCode) {
      setError('Choose your bank.');
      return;
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      setError('Enter your 10-digit account number.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch<PayoutBankResolveResponse>(
      '/v1/me/payout-destination/resolve',
      { method: 'POST', body: { bankCode, accountNumber } },
    );
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.code));
      return;
    }
    setResolved(result.data);
  };

  const sendCode = async () => {
    if (!accountName) {
      setError('Enter the name on the account.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/me/payout-destination/code', {
      method: 'POST',
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.code));
      return;
    }
    setResent(step === 'code');
    setCode('');
    setStep('code');
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch<PayoutDestinationView | null>(
      '/v1/me/payout-destination',
      {
        method: 'PUT',
        body: { bankCode, accountNumber, accountName, emailCode: code },
      },
    );
    setBusy(false);
    if (!result.ok) {
      setCode('');
      setResent(false);
      if (result.code === 'BANK_CHANGE_HELD') void load();
      setError(
        result.code === 'CODE_INVALID' || result.code === 'SIGN_IN_LOCKED'
          ? messageFor(result.code)
          : // The code is spent once it is right, so another try needs a new one.
            `${messageFor(result.code)} You’ll need a new code to try again.`,
      );
      if (result.code !== 'CODE_INVALID' && result.code !== 'SIGN_IN_LOCKED')
        setStep('details');
      return;
    }
    setState((current) =>
      current.kind === 'ready'
        ? { ...current, destination: result.data }
        : current,
    );
    setChanging(false);
    resetForm();
  };

  if (state.kind === 'loading')
    return (
      <Card id="get-paid" className="settings-section" aria-busy="true">
        <h3>Get paid</h3>
        <p className="tm-hint">Checking your bank account…</p>
      </Card>
    );
  if (state.kind === 'failed')
    return (
      <Card id="get-paid" className="settings-section">
        <h3>Get paid</h3>
        <Notice tone="error" title="Couldn’t load your bank account">
          Please try again.
        </Notice>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );

  const { destination, banks, bankChangesFrom } = state;
  const showForm =
    !bankChangesFrom &&
    (changing || !destination || destination.status === 'rejected');

  return (
    <Card id="get-paid" className="settings-section">
      <h3>Get paid</h3>
      <p className="tm-hint">The bank account your withdrawals go to.</p>
      {destination && (
        <p role="status">
          {destination.bankName} ••{destination.last4}:{' '}
          <strong>{STATUS_WORDS[destination.status]}</strong>
        </p>
      )}
      {destination?.status === 'pending_review' && (
        <p className="tm-hint">
          You can withdraw once it’s confirmed. We’ll keep checking.
        </p>
      )}
      {destination?.status === 'rejected' && (
        <p className="tm-hint">
          The payment provider can’t pay to this account. Please add another.
        </p>
      )}
      {bankChangesFrom && (
        <Notice title="Bank changes are paused for now">
          You changed your sign-in email recently, so for your security your
          bank account can’t be added or changed until{' '}
          {new Date(bankChangesFrom).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
          .
          {destination?.status === 'usable' &&
            ` Withdrawals keep going to ${destination.bankName} ••${destination.last4}.`}
        </Notice>
      )}
      {!showForm && !bankChangesFrom && (
        <Button variant="secondary" onClick={() => setChanging(true)}>
          Change bank account
        </Button>
      )}
      {showForm && (
        <form onSubmit={save} className="settings-form" noValidate>
          {step === 'details' && (
            <>
              <div className="tm-field">
                <label htmlFor={`${id}-bank`}>Bank</label>
                <select
                  id={`${id}-bank`}
                  className="tm-input"
                  value={bankCode}
                  disabled={busy}
                  onChange={(event) => {
                    setBankCode(event.target.value);
                    setResolved(null);
                  }}
                >
                  <option value="">Choose your bank</option>
                  {banks.map((bank) => (
                    <option key={bank.code} value={bank.code}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </div>
              <InputField
                id={`${id}-number`}
                label="Account number"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                value={accountNumber}
                disabled={busy}
                onChange={(event) => {
                  setAccountNumber(event.target.value.replace(/\D/g, ''));
                  setResolved(null);
                }}
              />
              {resolved?.resolved === true && (
                <InputField
                  id={`${id}-name`}
                  label="Name on the account"
                  value={resolved.accountName}
                  readOnly
                />
              )}
              {resolved?.resolved === false && (
                <InputField
                  id={`${id}-name`}
                  label="Name on the account"
                  hint="We couldn’t find this name at the bank. Enter it as your bank shows it."
                  maxLength={100}
                  value={typedName}
                  disabled={busy}
                  onChange={(event) => setTypedName(event.target.value)}
                />
              )}
              {!resolved ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void lookUp()}
                >
                  {busy ? 'Checking…' : 'Check account'}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendCode()}
                >
                  {busy ? 'Sending…' : 'Email me a code'}
                </Button>
              )}
            </>
          )}
          {step === 'code' && (
            <>
              <p className="tm-hint">
                We’ve sent a code to your email. Enter it to save this bank
                account.
              </p>
              <InputField
                id={`${id}-code`}
                label="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ''))
                }
              />
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save bank account'}
              </Button>
              {resent && <p role="status">We’ve sent a new code.</p>}
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void sendCode()}
              >
                Send a new code
              </Button>
              {!changing && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={resetForm}
                >
                  Cancel
                </Button>
              )}
            </>
          )}
          {error && (
            <Notice tone="error" title="Not saved">
              {error}
            </Notice>
          )}
          {changing && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setChanging(false);
                resetForm();
              }}
            >
              {step === 'code' ? 'Cancel' : 'Keep my current account'}
            </Button>
          )}
        </form>
      )}
    </Card>
  );
}
