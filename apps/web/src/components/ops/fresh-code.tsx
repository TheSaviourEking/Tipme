'use client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, InputField, Notice } from '@tipme/ui';
import { setFreshCodePrompt } from '@/lib/ops-staff-api';
import { apiFetch } from '@/lib/session-client';

const PROBLEMS: Record<string, string> = {
  CODE_INVALID:
    'That code didn’t work. Wait for the next code in your app and try again.',
  CODE_ALREADY_USED:
    'That code has just been used. Wait for the next one in your app.',
  OPS_LOCKED: 'Too many tries. Wait a few minutes, then try again.',
  RATE_LIMITED: 'Too many tries. Wait a few minutes, then try again.',
  VALIDATION_FAILED: 'The code is the 6 digits your app shows now.',
  NETWORK: 'We got no answer. Check your connection and try again.',
};

/**
 * Asks for an authenticator code when the server says an action needs one, then lets that action
 * go on. A native dialog, so focus stays inside, Escape leaves and focus returns where it was. It
 * opens with no animation (admin motion stays nearly still).
 */
export function FreshCodePrompt() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  // One prompt however many calls were refused at once; they all go on together.
  const waiters = useRef<((entered: boolean) => void)[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const settle = (entered: boolean) => {
    dialog.current?.close();
    setOpen(false);
    setError('');
    const waiting = waiters.current;
    waiters.current = [];
    for (const resolve of waiting) resolve(entered);
  };

  useEffect(() => {
    setFreshCodePrompt(
      () =>
        new Promise<boolean>((resolve) => {
          waiters.current.push(resolve);
          if (!dialog.current?.open) dialog.current?.showModal();
          setOpen(true);
        }),
    );
    return () => setFreshCodePrompt(null);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/ops/grant', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (result.ok) settle(true);
    else
      setError(PROBLEMS[result.code] ?? 'That didn’t work. Please try again.');
  };

  return (
    <dialog
      ref={dialog}
      className="ops-code-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        // Escape: settled here so whatever asked hears "no code" straight away.
        event.preventDefault();
        settle(false);
      }}
    >
      {open && (
        <form className="settings-form" onSubmit={(e) => void submit(e)}>
          <h2 id={`${id}-title`}>Enter a fresh code</h2>
          <p className="tm-hint">
            This needs a code from your authenticator app, so an unattended
            laptop can’t do it. Nothing has happened yet, and it goes ahead once
            you enter one.
          </p>
          <InputField
            id={`${id}-code`}
            name="code"
            label="Authenticator code"
            hint="The 6-digit code your app shows now."
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
          />
          {error && (
            <Notice tone="error" title="Not accepted">
              {error}
            </Notice>
          )}
          <div className="ops-actions">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              Continue
            </Button>
            <Button variant="quiet" onClick={() => settle(false)}>
              Not now
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
