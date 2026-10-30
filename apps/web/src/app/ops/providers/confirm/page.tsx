'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Notice, Skeleton } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

/** Opened from a provider test email. The token is in the fragment, so it never reaches logs. */
export default function ConfirmProviderTestPage() {
  const [state, setState] = useState<'working' | 'confirmed' | 'invalid'>(
    'working',
  );
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
    history.replaceState(null, '', location.pathname);
    void apiFetch<{ outcome: 'confirmed' | 'invalid' }>(
      '/v1/ops/providers/tests/confirm',
      { method: 'POST', body: { token } },
    ).then((result) =>
      setState(
        result.ok && result.data.outcome === 'confirmed'
          ? 'confirmed'
          : 'invalid',
      ),
    );
  }, []);
  return (
    <>
      <h1>Provider test</h1>
      {state === 'working' && <Skeleton />}
      {state === 'confirmed' && (
        <Notice tone="success" title="Test confirmed">
          This provider delivers mail. It can be made active for the next 24
          hours.
        </Notice>
      )}
      {state === 'invalid' && (
        <Notice tone="error" title="This link doesn’t work">
          It may be over 24 hours old or already used. Send a new test.
        </Notice>
      )}
      <p>
        <Link href="/ops/providers">Back to Providers</Link>
      </p>
    </>
  );
}
