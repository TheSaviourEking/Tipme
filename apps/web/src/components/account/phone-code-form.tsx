'use client';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SignInVerified } from '@tipme/contracts';
import { Button, InputField } from '@tipme/ui';
import { apiFetch, deviceLabel } from '@/lib/session-client';

/**
 * Phone number, then a 6-digit code sent by WhatsApp (SMS if WhatsApp fails). Used for both
 * signing in and signing up: the first successful code creates the account.
 */
export function PhoneCodeForm({
  onSignedIn,
}: {
  onSignedIn: (result: SignInVerified) => void;
}) {
  const id = useId();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codeField = useRef<HTMLInputElement>(null);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (phone.replace(/\D/g, '').length < 7) {
      setError('Enter your phone number, for example 0803 123 4567.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/auth/code', {
      method: 'POST',
      body: { phone },
    });
    setBusy(false);
    if (!result.ok) {
      setError(
        result.code === 'RATE_LIMITED'
          ? 'Too many codes were requested. Please wait a while and try again.'
          : 'We couldn’t send a code. Check your connection and try again.',
      );
      return;
    }
    setStep('code');
    requestAnimationFrame(() => codeField.current?.focus());
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6 digits from the message.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch<SignInVerified>('/v1/auth/verify', {
      method: 'POST',
      body: { phone, code, deviceLabel: deviceLabel() },
    });
    setBusy(false);
    if (result.ok) {
      onSignedIn(result.data);
      return;
    }
    setError(
      result.code === 'SIGN_IN_LOCKED'
        ? 'Too many wrong codes. Please wait 15 minutes and try again.'
        : result.code === 'RECOVERY_PENDING'
          ? 'This number is waiting to be moved to an account. Try again when the 24 hours are up.'
          : result.code === 'CODE_INVALID'
            ? 'That code isn’t right or has expired. Check it, or send a new one.'
            : 'We couldn’t check the code. Please try again.',
    );
  };

  return step === 'phone' ? (
    <form className="auth-form" onSubmit={sendCode} noValidate>
      <InputField
        id={`${id}-phone`}
        label="Phone number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="0803 123 4567"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={error || undefined}
        hint="We’ll send a 6-digit code by WhatsApp, or by SMS if WhatsApp doesn’t work."
      />
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {busy ? 'Sending…' : 'Send code'}
      </Button>
    </form>
  ) : (
    <form className="auth-form" onSubmit={verify} noValidate>
      <p role="status">We sent a code to {phone}. It expires in 10 minutes.</p>
      <InputField
        id={`${id}-code`}
        ref={codeField}
        label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        error={error || undefined}
      />
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
      <div className="auth-form__links">
        <Button variant="quiet" onClick={() => void sendCode()}>
          Send a new code
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setStep('phone');
            setCode('');
            setError('');
          }}
        >
          Use a different number
        </Button>
      </div>
    </form>
  );
}
