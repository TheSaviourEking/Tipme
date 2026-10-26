'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Skeleton } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

/** The link's token is in the fragment (#v=…), so it never reaches a server log. */
export function VerifyEmail() {
  const [state, setState] = useState<'checking' | 'confirmed' | 'invalid'>(
    'checking',
  );
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('v') ?? '';
    history.replaceState(null, '', location.pathname);
    void apiFetch('/v1/auth/email/confirm', {
      method: 'POST',
      body: { token },
    }).then((result) => setState(result.ok ? 'confirmed' : 'invalid'));
  }, []);
  if (state === 'checking') return <Skeleton label="Confirming your email" />;
  return state === 'confirmed' ? (
    <>
      <h1>Email confirmed</h1>
      <p>
        We’ll email you when a tip is confirmed. You can also use this address
        to recover your account.
      </p>
      <Link className="tm-button tm-button--primary" href="/dashboard">
        Go to your dashboard
      </Link>
    </>
  ) : (
    <>
      <h1>This link doesn’t work</h1>
      <p>
        It may have expired or already been used. Ask for a new one in your
        settings.
      </p>
      <Link className="tm-button tm-button--primary" href="/dashboard/settings">
        Open settings
      </Link>
    </>
  );
}
