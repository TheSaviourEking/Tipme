'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  CollectBankAddResponse,
  CollectBankLookupResponse,
  CollectBankState,
  CollectBankView,
  PayoutBank,
} from '@tipme/contracts';
import { COLLECT_COPY, collectLegalNameSchema } from '@tipme/contracts';
import { Button, InputField, Slip, Surface } from '@tipme/ui';
import { BankPicker } from '@/components/account/bank-picker';
import { CodeField } from '@/components/account/code-field';
import { messageFor } from '@/components/account/get-paid-card';
import { apiFetch } from '@/lib/session-client';

type Step =
  | { kind: 'details' }
  | { kind: 'looking' }
  | { kind: 'confirm'; bankName: string }
  | { kind: 'sending'; bankName: string }
  | { kind: 'code'; bankName: string }
  | { kind: 'adding' };

/** A refusal whose words the server owns (Task 13): shown as it sends them. */
const SERVER_WORDS = new Set([
  'BANK_RECHECK_LATER',
  'NAME_LOCKED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'WITHDRAWALS_PAUSED',
]);

const words = (result: { code: string; message?: string }) =>
  SERVER_WORDS.has(result.code) && result.message
    ? result.message
    : messageFor(result.code);

const validPart = (value: string) =>
  collectLegalNameSchema.shape.first.safeParse(value).success;

/** "We're checking your details": the same line while the partner checks and after, until it ends. */
function Checking() {
  return (
    <p role="status" className="bank-check collect-bank__checking">
      <span className="bank-check__spin" aria-hidden="true" />
      {COLLECT_COPY.checking}
    </p>
  );
}

/**
 * You collect (plan Task 14, spec §2.1 steps 4–5): a recipient's first bank details. Their name as
 * their bank has it, the bank and the number; TipMe shows the bank's name for the account ("Is this
 * you?"), they confirm, a code from their email proves it is them (a stolen session can't add a
 * bank), and our payment partner compares the names. A mismatch is said at the account number and
 * nothing is kept. `bank` is what `GET /v1/me/collect` holds; `onAdded` tells the page to read it again,
 * and `onCheckAgain` reads it again for "Check again". Settings reuses it to change a verified bank
 * (`title`), under the same locked name.
 */
export function CollectBankForm({
  bank,
  read,
  banks,
  onAdded,
  onCheckAgain,
  title = COLLECT_COPY.withdrawNoBank,
}: {
  bank: CollectBankView | null;
  /** The status read `bank` came from: a new object for each read, even when `bank` is unchanged. */
  read: object;
  /** The partner's list (`GET /v1/payout-banks`), or null while it loads or when it failed. */
  banks: PayoutBank[] | null;
  onAdded: (state: CollectBankState | null) => void;
  onCheckAgain: () => Promise<void>;
  title?: string;
}) {
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: 'details' });
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    first?: string;
    last?: string;
    bank?: string;
    number?: string;
    code?: string;
  }>({});
  // A refusal the person can recover from, on a slip under the form.
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  // What the last add answered, with the latest read shown when it answered: kept only until the
  // page's next read arrives, which always wins. usePanel drops a read started before the add's own
  // re-read, so a newer read is never older than the answer.
  const [added, setAdded] = useState<{
    state: CollectBankState;
    over: object;
  } | null>(null);
  // The latest status read the page has shown, for pinning the add's answer when it arrives: a read
  // answered while the add was on its way is older than the answer, never newer (re-review N1).
  const latestRead = useRef(read);
  // Before paint, not after: an answer can't arrive between a read's commit and this (R2-M1).
  useLayoutEffect(() => {
    latestRead.current = read;
  }, [read]);
  // One request per tap: a second tap while one is on its way does nothing.
  const inFlight = useRef(false);
  const [checkingAgain, setCheckingAgain] = useState(false);
  const codeField = useRef<HTMLInputElement>(null);
  const confirmKey = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);
  // Bumped on each refusal at a field, so the first field it marks takes focus.
  const [refused, setRefused] = useState(0);

  // Each step's first control takes focus as it appears, so the keyboard goes on from where it was:
  // Continue to Confirm, Confirm to the code, a refusal to its field.
  useEffect(() => {
    if (step.kind === 'code') codeField.current?.focus();
    if (step.kind === 'confirm') confirmKey.current?.focus();
  }, [step.kind]);
  useEffect(() => {
    if (refused === 0) return;
    section.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [refused]);

  if (added && read !== added.over) {
    setAdded(null);
    // Answered as being checked, and now no bank at all: our payment partner refused it, and a
    // refused bank is never kept. Said at the account number, as a mismatch at the add is.
    if (bank === null && added.state !== 'verified') {
      setStep({ kind: 'details' });
      setFieldErrors({ number: COLLECT_COPY.nameMismatch });
      setRefused((n) => n + 1);
    }
  }
  const state =
    (added && read === added.over ? added.state : null) ?? bank?.state ?? null;
  if (state === 'manual_review')
    return (
      <Slip tone="neutral" title={COLLECT_COPY.manualCheck}>
        {bank && `${bank.bankName} ••${bank.last4}`}
      </Slip>
    );
  if (state === 'checking')
    return (
      <div className="collect-bank__waiting">
        <Checking />
        <Button
          variant="secondary"
          disabled={checkingAgain}
          aria-busy={checkingAgain}
          onClick={async () => {
            setCheckingAgain(true);
            await onCheckAgain();
            setCheckingAgain(false);
          }}
        >
          Check again
        </Button>
      </div>
    );
  if (state === 'verified')
    return <Slip tone="done" title={COLLECT_COPY.verified} />;

  const clearError = (field: keyof typeof fieldErrors) =>
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });

  const toDetails = () => {
    setStep({ kind: 'details' });
    setCode('');
    setResent(false);
  };

  /** Runs one request at a time: a double tap sends one. */
  const once =
    <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await run(...args);
      } finally {
        inFlight.current = false;
      }
    };

  const lookUp = once(async (event: FormEvent) => {
    event.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!validPart(first)) errors.first = 'Enter your first name.';
    if (!validPart(last)) errors.last = 'Enter your last name.';
    if (!bankCode) errors.bank = 'Choose your bank.';
    if (!/^\d{10}$/.test(accountNumber))
      errors.number = 'Enter your 10-digit account number.';
    setFieldErrors(errors);
    setError('');
    if (Object.keys(errors).length > 0) {
      setRefused((n) => n + 1);
      return;
    }
    setStep({ kind: 'looking' });
    const result = await apiFetch<CollectBankLookupResponse>(
      '/v1/me/collect/bank/lookup',
      {
        method: 'POST',
        body: {
          legalName: { first: first.trim(), last: last.trim() },
          bankCode,
          accountNumber,
        },
      },
    );
    if (result.ok) {
      setStep({ kind: 'confirm', bankName: result.data.bankName });
      return;
    }
    setStep({ kind: 'details' });
    if (result.code === 'BANK_NAME_UNKNOWN') {
      setFieldErrors({
        number:
          result.message ??
          'We couldn’t find this account. Check the bank and account number.',
      });
      setRefused((n) => n + 1);
    } else if (result.code === 'RATE_LIMITED')
      setError('You’ve used today’s account checks. Try again tomorrow.');
    else setError(words(result));
  });

  const sendCode = once(async (bankName: string) => {
    setStep({ kind: 'sending', bankName });
    setError('');
    const result = await apiFetch('/v1/me/payout-destination/code', {
      method: 'POST',
    });
    if (!result.ok) {
      setStep({ kind: 'confirm', bankName });
      setError(messageFor(result.code));
      return;
    }
    setResent(step.kind === 'code');
    setCode('');
    setFieldErrors({});
    setStep({ kind: 'code', bankName });
  });

  const add = once(async (event: FormEvent, bankName: string) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: 'Enter the 6-digit code from your email.' });
      setRefused((n) => n + 1);
      return;
    }
    setFieldErrors({});
    setError('');
    setStep({ kind: 'adding' });
    const result = await apiFetch<CollectBankAddResponse>(
      '/v1/me/collect/bank',
      {
        method: 'POST',
        body: {
          legalName: { first: first.trim(), last: last.trim() },
          bankCode,
          accountNumber,
          confirmed: true,
          emailCode: code,
        },
      },
    );
    if (result.ok) {
      setAdded({ state: result.data.state, over: latestRead.current });
      onAdded(result.data.state);
      return;
    }
    setCode('');
    setResent(false);
    // A wrong code spends nothing: try it again here.
    if (result.code === 'CODE_INVALID' || result.code === 'SIGN_IN_LOCKED') {
      setStep({ kind: 'code', bankName });
      setFieldErrors({ code: messageFor(result.code) });
      setRefused((n) => n + 1);
      return;
    }
    setStep({ kind: 'details' });
    // Nothing is saved (spec §2.1 step 5): said at the account number, where the change is made.
    if (result.code === 'NAME_MISMATCH') {
      setFieldErrors({ number: COLLECT_COPY.nameMismatch });
      setRefused((n) => n + 1);
      return;
    }
    // No answer: whether it was added is unknown, so the page reads where it stands.
    if (result.status === 0 || result.status >= 500) onAdded(null);
    // The code is spent once it is right, so another try needs a new one.
    setError(
      SERVER_WORDS.has(result.code)
        ? words(result)
        : `${words(result)} You’ll need a new code to try again.`,
    );
  });

  const errorSlip = error && (
    <Slip tone="error" title="Not added">
      {error}
    </Slip>
  );

  if (step.kind === 'adding')
    return (
      <section className="collect-bank" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>{title}</h2>
        <Checking />
      </section>
    );

  return (
    <section
      ref={section}
      className="collect-bank"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="tm-hint">{COLLECT_COPY.withdrawOwnName}</p>
      <Surface material="paper" className="collect-bank__panel">
        {(step.kind === 'details' || step.kind === 'looking') && (
          <form className="settings-form" onSubmit={lookUp} noValidate>
            <p className="tm-hint">Use the name on your bank account.</p>
            <InputField
              id={`${id}-first`}
              label="First name"
              autoComplete="given-name"
              maxLength={60}
              value={first}
              disabled={step.kind === 'looking'}
              error={fieldErrors.first}
              onChange={(event) => {
                setFirst(event.target.value);
                clearError('first');
              }}
            />
            <InputField
              id={`${id}-last`}
              label="Last name"
              autoComplete="family-name"
              maxLength={60}
              value={last}
              disabled={step.kind === 'looking'}
              error={fieldErrors.last}
              onChange={(event) => {
                setLast(event.target.value);
                clearError('last');
              }}
            />
            {banks ? (
              <BankPicker
                id={id}
                banks={banks}
                value={bankCode}
                disabled={step.kind === 'looking'}
                error={fieldErrors.bank}
                onChange={(next) => {
                  setBankCode(next);
                  clearError('bank');
                }}
              />
            ) : (
              <p className="tm-hint">Loading the list of banks…</p>
            )}
            <InputField
              id={`${id}-number`}
              label="Account number"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              value={accountNumber}
              disabled={step.kind === 'looking'}
              error={fieldErrors.number}
              onChange={(event) => {
                setAccountNumber(event.target.value.replace(/\D/g, ''));
                clearError('number');
              }}
            />
            {step.kind === 'looking' && (
              <p role="status" className="bank-check">
                <span className="bank-check__spin" aria-hidden="true" />
                Finding your account…
              </p>
            )}
            <Button
              type="submit"
              variant="continue"
              disabled={step.kind === 'looking' || !banks}
              aria-busy={step.kind === 'looking'}
            >
              Continue
            </Button>
            {errorSlip}
          </form>
        )}
        {(step.kind === 'confirm' || step.kind === 'sending') && (
          <div className="settings-form">
            <p className="collect-bank__name" role="status">
              {COLLECT_COPY.nameConfirm(step.bankName)}
            </p>
            <div className="collect-bank__keys">
              <Button
                ref={confirmKey}
                variant="continue"
                disabled={step.kind === 'sending'}
                aria-busy={step.kind === 'sending'}
                onClick={() => void sendCode(step.bankName)}
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                disabled={step.kind === 'sending'}
                onClick={toDetails}
              >
                Change
              </Button>
            </div>
            {errorSlip}
          </div>
        )}
        {step.kind === 'code' && (
          <form
            className="settings-form"
            onSubmit={(event) => void add(event, step.bankName)}
            noValidate
          >
            <p className="collect-bank__name">
              {COLLECT_COPY.nameConfirm(step.bankName)}
            </p>
            <p className="tm-hint">
              We’ve sent a code to your email. Enter it to add your bank
              details.
            </p>
            <CodeField
              ref={codeField}
              id={`${id}-code`}
              label="6-digit code"
              value={code}
              error={fieldErrors.code}
              onChange={(digits) => {
                setCode(digits);
                setFieldErrors({});
              }}
            />
            <Button type="submit" variant="continue">
              Add bank details
            </Button>
            {resent && <p role="status">We’ve sent a new code.</p>}
            <div className="collect-bank__keys">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void sendCode(step.bankName)}
              >
                Send a new code
              </Button>
              <Button type="button" variant="secondary" onClick={toDetails}>
                Change
              </Button>
            </div>
            {errorSlip}
          </form>
        )}
      </Surface>
    </section>
  );
}
