'use client';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { HandleStatus } from '@tipme/contracts';
import { Button, InputField } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';
import { useSiteHost } from '@/lib/site-host';

const describe: Record<HandleStatus, string> = {
  available: '',
  taken: 'That handle is taken. Try another.',
  reserved: 'That handle is reserved. Try another.',
  invalid: 'Use 3–30 letters, numbers or underscores.',
};

/** Choose a handle, with a live availability check, and claim it. */
export function HandleClaim({ onClaimed }: { onClaimed: () => void }) {
  const id = useId();
  const host = useSiteHost();
  const [raw, setRaw] = useState('');
  const [check, setCheck] = useState<{
    for: string;
    status: HandleStatus;
    handle: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (raw.trim().length < 3) return;
    const value = raw.trim();
    const timer = setTimeout(() => {
      void apiFetch<{ handle: string | null; status: HandleStatus }>(
        `/v1/handles/${encodeURIComponent(value)}/availability`,
      ).then((result) => {
        if (result.ok) setCheck({ for: value, ...result.data });
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [raw]);

  const current = check && check.for === raw.trim() ? check : null;
  const tooShort = raw.trim().length > 0 && raw.trim().length < 3;
  const available = current?.status === 'available' ? current.handle : null;
  const message = tooShort
    ? describe.invalid
    : current && current.status !== 'available'
      ? describe[current.status]
      : '';

  const claim = async (event: FormEvent) => {
    event.preventDefault();
    if (!available) return;
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/me/page', {
      method: 'POST',
      body: { handle: available },
    });
    setBusy(false);
    if (result.ok) {
      onClaimed();
      return;
    }
    setError(
      result.code === 'HANDLE_TAKEN'
        ? 'Someone just took that handle. Try another.'
        : result.code === 'ALREADY_HAS_PAGE'
          ? 'You already have a page.'
          : 'We couldn’t claim it. Please try again.',
    );
  };

  return (
    <form className="auth-form" onSubmit={claim} noValidate>
      <h2>Choose your handle</h2>
      <p className="tm-hint">
        It becomes your link. You can change it later in Settings.
      </p>
      <p className="handle-link" aria-hidden="true">
        {host}/@<span>{raw.trim() || 'yourhandle'}</span>
      </p>
      <InputField
        id={`${id}-handle`}
        label="Handle"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={30}
        value={raw}
        onChange={(event) => setRaw(event.target.value.replace(/^@/, ''))}
        error={message || error || undefined}
      />
      <p aria-live="polite" className="handle-status">
        {available ? `@${available} is available` : ''}
      </p>
      <Button type="submit" disabled={!available || busy} aria-busy={busy}>
        {available ? `Claim @${available}` : 'Claim handle'}
      </Button>
    </form>
  );
}
