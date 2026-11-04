'use client';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SignInVerified } from '@tipme/contracts';
import { Button, InputField } from '@tipme/ui';
import { CodeField } from '@/components/account/code-field';
import { apiFetch, deviceLabel } from '@/lib/session-client';

/** a•••@example.com: enough to recognise the address, not to read it over a shoulder. */
const maskEmail = (email: string) => {
  const [name = '', domain = ''] = email.trim().split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
};

/**
 * Email address, then a 6-digit code sent to it. Used for both signing in and signing up: the
 * first successful code creates the account.
 */
export function EmailCodeForm({
  onSignedIn,
  onStepChange,
}: {
  onSignedIn: (result: SignInVerified) => void;
  /** Lets a surrounding progress indicator follow the number → code steps. */
  onStepChange?: (step: 'email' | 'code') => void;
}) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStepState] = useState<'email' | 'code'>('email');
  const setStep = (next: 'email' | 'code') => {
    setStepState(next);
    onStepChange?.(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codeField = useRef<HTMLInputElement>(null);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError('Enter your email address, for example ada@example.com.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/auth/code', {
      method: 'POST',
      body: { email: email.trim() },
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
      setError('Enter the 6 digits from the email.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiFetch<SignInVerified>('/v1/auth/verify', {
      method: 'POST',
      body: { email: email.trim(), code, deviceLabel: deviceLabel() },
    });
    setBusy(false);
    if (result.ok) {
      onSignedIn(result.data);
      return;
    }
    setError(
      result.code === 'SIGN_IN_LOCKED'
        ? 'Too many wrong codes. Please wait 15 minutes and try again.'
        : result.code === 'CODE_INVALID'
          ? 'That code isn’t right or has expired. Check it, or send a new one.'
          : 'We couldn’t check the code. Please try again.',
    );
  };

  return step === 'email' ? (
    <form className="auth-form" onSubmit={sendCode} noValidate>
      <InputField
        id={`${id}-email`}
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="ada@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={error || undefined}
        hint="We’ll email you a 6-digit code. Signing in with a phone number is coming soon."
      />
      <Button type="submit" variant="continue" disabled={busy} aria-busy={busy}>
        {busy ? 'Sending…' : 'Send code'}
      </Button>
    </form>
  ) : (
    <form className="auth-form" onSubmit={verify} noValidate>
      <h2 className="auth-step-title">Check your email.</h2>
      <p role="status">
        We sent a 6-digit code to {maskEmail(email)}. It expires in 10 minutes.
        Check your spam folder if it doesn’t arrive.
      </p>
      <CodeField
        id={`${id}-code`}
        ref={codeField}
        label="6-digit code"
        value={code}
        onChange={setCode}
        error={error || undefined}
      />
      <Button type="submit" variant="continue" disabled={busy} aria-busy={busy}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
      <div className="auth-form__links">
        <Button variant="quiet" onClick={() => void sendCode()}>
          Send a new code
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setStep('email');
            setCode('');
            setError('');
          }}
        >
          Use a different email
        </Button>
      </div>
    </form>
  );
}
