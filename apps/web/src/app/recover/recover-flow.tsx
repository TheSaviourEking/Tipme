'use client';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { Button, InputField, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

type Step = 'email' | 'code' | 'confirm' | 'scheduled';

/**
 * Lost the sign-in email: a code to the recovery email, then a code to the new address, then a
 * 24-hour wait in which the old address is told. Someone staff are helping joins at "confirm".
 */
export function RecoverFlow() {
  const id = useId();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newCode, setNewCode] = useState('');
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);
  // Sent here by staff: this form hasn't collected the addresses yet.
  const [fromStaff, setFromStaff] = useState(false);
  const [effectiveAt, setEffectiveAt] = useState('');

  // Codes run out after 10 minutes, and 5 wrong tries pause an address for 15.
  const wrongCode =
    'That code isn’t right or has expired. Check it, or wait 15 minutes and send a new one.';
  /** One request at a time: a double tap would use up codes or the code just sent. */
  const once = (work: () => Promise<void>) => async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setCodeError('');
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const start = once(async () => {
    const result = await apiFetch('/v1/auth/email-recovery/start', {
      method: 'POST',
      body: { email: email.trim() },
    });
    if (result.ok) setStep('code');
    else setError('We couldn’t send that. Please try again in a while.');
  });
  const propose = once(async () => {
    const result = await apiFetch('/v1/auth/email-recovery/propose', {
      method: 'POST',
      body: {
        email: email.trim(),
        code: recoveryCode,
        newEmail: newEmail.trim(),
      },
    });
    if (result.ok) setStep('confirm');
    else if (result.code === 'EMAIL_INVALID')
      setError('Check this address and try again.');
    else if (result.code === 'TOO_MANY_CODES')
      setError(
        'That address can’t get a code right now. Try another, or wait an hour.',
      );
    else setCodeError(wrongCode);
  });
  const confirm = once(async () => {
    const result = await apiFetch<{ effectiveAt: string }>(
      '/v1/auth/email-recovery/confirm',
      {
        method: 'POST',
        body: { email: email.trim(), newEmail: newEmail.trim(), code: newCode },
      },
    );
    if (result.ok) {
      setEffectiveAt(result.data.effectiveAt);
      setStep('scheduled');
    } else if (result.code === 'EMAIL_TAKEN')
      setError(
        'That address is already on another TipMe account. Start again with a different one.',
      );
    else setError(wrongCode);
  });

  if (step === 'scheduled')
    return (
      <Notice tone="success" title="Your account will move in 24 hours">
        It moves on{' '}
        {new Date(effectiveAt).toLocaleString('en-NG', {
          timeZone: 'Africa/Lagos',
        })}
        . We told your old address, in case this wasn’t you. After that, sign in
        with your new email.
      </Notice>
    );
  const digits = (value: string) => value.replace(/\D/g, '');
  if (step === 'email')
    return (
      <form className="auth-form" onSubmit={(e) => void start(e)} noValidate>
        <InputField
          id={`${id}-email`}
          label="Your sign-in email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error || undefined}
          hint="The one you can’t get into. If it has a recovery email, we’ll send a code there."
        />
        <Button type="submit" disabled={busy}>
          Send recovery code
        </Button>
        <p className="auth-switch">
          No recovery email? Contact{' '}
          <a href="mailto:support@usetipme.xyz">support@usetipme.xyz</a> and
          we’ll check it’s you. Already spoke to us?{' '}
          <Button
            variant="quiet"
            onClick={() => {
              setFromStaff(true);
              setStep('confirm');
            }}
          >
            Enter the code we sent to your new email
          </Button>
        </p>
        <p className="auth-switch">
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </form>
    );
  if (step === 'code')
    return (
      <form className="auth-form" onSubmit={(e) => void propose(e)} noValidate>
        <p role="status">
          If that account has a recovery email, we sent a code to it. It expires
          in 10 minutes. If nothing arrives, you may have asked too many times:
          try again in an hour.
        </p>
        <InputField
          id={`${id}-recovery-code`}
          label="Code sent to your recovery email"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={recoveryCode}
          onChange={(e) => setRecoveryCode(digits(e.target.value))}
          error={codeError || undefined}
        />
        <InputField
          id={`${id}-new-email`}
          label="New sign-in email"
          type="email"
          autoComplete="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          error={error || undefined}
        />
        <Button type="submit" disabled={busy}>
          Send code to new email
        </Button>
      </form>
    );
  return (
    <form className="auth-form" onSubmit={(e) => void confirm(e)} noValidate>
      {fromStaff && (
        <>
          <InputField
            id={`${id}-old`}
            label="Your old sign-in email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <InputField
            id={`${id}-new`}
            label="New sign-in email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </>
      )}
      <InputField
        id={`${id}-new-code`}
        label="Code sent to your new email"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={newCode}
        onChange={(e) => setNewCode(digits(e.target.value))}
        error={error || undefined}
      />
      <Button type="submit" disabled={busy}>
        Move my account
      </Button>
      {fromStaff && (
        <p className="auth-switch">
          Codes last 10 minutes. If yours has run out, ask support to send a new
          one.
        </p>
      )}
    </form>
  );
}
