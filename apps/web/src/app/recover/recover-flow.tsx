'use client';
import { useId, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { Button, InputField, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

/**
 * Without a link: ask for one by email. With a link (#r=…): attach a new number, confirmed by a
 * code sent to that number. Recovery never signs anyone in by email alone.
 */
const noSubscription = () => () => undefined;

export function RecoverFlow() {
  const id = useId();
  // The link's token stays in the fragment (never sent to a server) until recovery is done.
  const token = useSyncExternalStore(
    noSubscription,
    () => new URLSearchParams(location.hash.slice(1)).get('r'),
    () => null,
  );
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [chosen, setChosen] = useState<
    'email' | 'sent' | 'phone' | 'code' | 'scheduled'
  >('email');
  const step = token && chosen === 'email' ? 'phone' : chosen;
  const setStep = setChosen;
  const [error, setError] = useState('');

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    await apiFetch('/v1/auth/recover', { method: 'POST', body: { email } });
    setStep('sent');
  };
  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    const result = await apiFetch('/v1/auth/recover/code', {
      method: 'POST',
      body: { token, phone },
    });
    if (result.ok) setStep('code');
    else setError('This link has expired. Ask for a new one.');
  };
  const finish = async (event: FormEvent) => {
    event.preventDefault();
    const result = await apiFetch('/v1/auth/recover/complete', {
      method: 'POST',
      body: { token, phone, code },
    });
    if (result.ok) {
      history.replaceState(null, '', location.pathname);
      setStep('scheduled');
    } else
      setError(
        result.code === 'PHONE_TAKEN'
          ? 'That number belongs to another account.'
          : 'That code isn’t right, or the link has expired.',
      );
  };

  if (step === 'scheduled')
    return (
      <p role="status">
        Done. Your account moves to {phone} in 24 hours; after that, sign in
        with that number. We told your old number and email, so the owner can
        stop it if this wasn’t them.
      </p>
    );
  if (step === 'sent')
    return (
      <p role="status">
        If that email is verified on a TipMe account, we sent it a link. It
        works for 30 minutes.
      </p>
    );
  if (step === 'email')
    return (
      <form className="auth-form" onSubmit={ask} noValidate>
        <p>
          We’ll email a link to your verified address so you can add a new
          number.
        </p>
        <InputField
          id={`${id}-email`}
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit">Email me a link</Button>
      </form>
    );
  return (
    <form
      className="auth-form"
      onSubmit={step === 'phone' ? sendCode : finish}
      noValidate
    >
      {error && (
        <Notice tone="error" title="Not done yet">
          {error}
        </Notice>
      )}
      <InputField
        id={`${id}-phone`}
        label="Your new phone number"
        type="tel"
        autoComplete="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={step === 'code'}
      />
      {step === 'code' && (
        <InputField
          id={`${id}-code`}
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      )}
      <Button type="submit">
        {step === 'phone' ? 'Send code' : 'Use this number'}
      </Button>
    </form>
  );
}
