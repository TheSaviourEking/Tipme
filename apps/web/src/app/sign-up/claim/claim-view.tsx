'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type {
  ClaimLinkPreview,
  MyProfile,
  UsernameClaimed,
} from '@tipme/contracts';
import { Button, Skeleton, Slip } from '@tipme/ui';
import { AuthStage } from '@/components/account/auth-stage';
import { EmailCodeForm } from '@/components/account/email-code-form';
import {
  claimPreviewWords,
  claimRefusalWords,
  clearClaimLink,
  takeClaimCode,
} from '@/lib/claim-link';
import { markClaimed } from '@/lib/claim-moment';
import { apiFetch } from '@/lib/session-client';

// The link's end, in Lagos time ("2 December 2026").
const day = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeZone: 'Africa/Lagos',
});

type Closed = Exclude<ClaimLinkPreview['state'], 'open'> | 'limited';
type View =
  | { step: 'checking' }
  | { step: 'closed'; state: Closed }
  | { step: 'sign-in'; name: string; expiresAt: string }
  | {
      step: 'confirm';
      name: string;
      expiresAt: string;
      /** The person's username now; null when they have no page yet. */
      current: string | null;
    }
  | { step: 'claimed'; name: string; previous: string | null };

/**
 * Claiming a username someone at TipMe kept for you (handover). The link is checked before anything
 * else, so a used, expired or cancelled one says so at once. Then the person signs up or signs in
 * (one email form does both), confirms, and the name moves to their page, or becomes their page.
 */
export function ClaimView() {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [view, setView] = useState<View>({ step: 'checking' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** What the link is now, and where this person is: signed out, without a page, or with one. */
  const look = useCallback(async (claimCode: string | null) => {
    if (!claimCode) {
      setView({ step: 'closed', state: 'invalid' });
      return;
    }
    const preview = await apiFetch<ClaimLinkPreview>(
      '/v1/handles/claim-link/preview',
      { method: 'POST', body: { code: claimCode } },
    );
    if (!preview.ok) {
      setView({
        step: 'closed',
        state: preview.status === 429 ? 'limited' : 'invalid',
      });
      return;
    }
    const link = preview.data;
    if (link.state !== 'open') {
      clearClaimLink();
      setView({ step: 'closed', state: link.state });
      return;
    }
    const me = await apiFetch<MyProfile>('/v1/me/profile');
    if (me.ok)
      setView({
        step: 'confirm',
        name: link.name,
        expiresAt: link.expiresAt,
        current: me.data.handle,
      });
    else if (me.status === 404)
      setView({
        step: 'confirm',
        name: link.name,
        expiresAt: link.expiresAt,
        current: null,
      });
    else
      setView({ step: 'sign-in', name: link.name, expiresAt: link.expiresAt });
  }, []);

  useEffect(() => {
    const read = () => {
      const taken = takeClaimCode();
      setCode(taken);
      setError('');
      void look(taken);
    };
    read();
    // Another link pasted into this tab changes only the fragment: read it as a new one.
    const another = () => {
      if (!location.hash) return;
      setView({ step: 'checking' });
      read();
    };
    window.addEventListener('hashchange', another);
    return () => window.removeEventListener('hashchange', another);
  }, [look]);

  const claim = async () => {
    if (!code || view.step !== 'confirm') return;
    setBusy(true);
    setError('');
    const result = await apiFetch<UsernameClaimed>('/v1/me/username-claim', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (result.ok) {
      clearClaimLink();
      if (result.data.created) {
        // A new page: the same welcome as any sign-up, with its one-time moment.
        markClaimed(result.data.handle);
        router.replace('/dashboard/welcome');
        return;
      }
      setView({
        step: 'claimed',
        name: result.data.handle,
        previous: result.data.previous,
      });
      return;
    }
    if (result.code === 'CLAIM_LINK_INVALID') {
      await look(code);
      return;
    }
    setError(claimRefusalWords(result.code, result.status));
  };

  if (view.step === 'checking')
    return (
      <AuthStage title="Claim your username" lede="Checking your link.">
        <Skeleton label="Checking your link" />
      </AuthStage>
    );

  if (view.step === 'closed') {
    const words =
      view.state === 'limited'
        ? {
            title: 'Too many tries from here',
            text: 'There have been a lot of tries from this connection. Wait an hour, then open the link again.',
          }
        : claimPreviewWords(view.state);
    return (
      <AuthStage
        title="Claim your username"
        lede="A claim link lets one person claim one username that the TipMe team kept for them."
      >
        <div className="auth-form">
          <h2>{words.title}</h2>
          <p>{words.text}</p>
          <p className="auth-switch">
            <Link href="/sign-in">Sign in</Link> or{' '}
            <Link href="/sign-up">create a page</Link> with a username of your
            own.
          </p>
        </div>
      </AuthStage>
    );
  }

  if (view.step === 'claimed')
    return (
      <AuthStage
        title={`@${view.name} is yours.`}
        lede="Your page has its new username."
      >
        <div className="auth-form">
          <h2>Done</h2>
          <p>
            Your page is now at /@{view.name}.
            {view.previous
              ? ` Links and QR codes with @${view.previous} keep leading to it.`
              : ''}
          </p>
          <Button variant="continue" onClick={() => router.push('/dashboard')}>
            Go to your dashboard
          </Button>
        </div>
      </AuthStage>
    );

  const until = day.format(new Date(view.expiresAt));
  return (
    <AuthStage
      title={`@${view.name} is waiting for you.`}
      lede="Someone at TipMe kept this username for you. Claim it with your TipMe account, or make one now with your email."
      promises={[
        'This link works once',
        `It works until ${until}`,
        'Your email stays private',
      ]}
    >
      {view.step === 'sign-in' ? (
        <>
          <EmailCodeForm onSignedIn={() => void look(code)} />
          <p className="auth-switch">
            New or already on TipMe, use your email: we’ll sign you in or make
            your account.
          </p>
        </>
      ) : (
        <div className="auth-form">
          <h2>Claim @{view.name}</h2>
          <p>
            {view.current
              ? `Your username changes from @${view.current} to @${view.name}. Links and QR codes with @${view.current} keep leading to your page. Your tips, balance and plan stay as they are.`
              : `Your page will be at /@${view.name}. You can set it up next; it isn’t public until you choose.`}
          </p>
          {error && (
            <Slip dense tone="error" title="Not claimed">
              {error}
            </Slip>
          )}
          <Button
            variant="continue"
            onClick={() => void claim()}
            disabled={busy}
            aria-busy={busy}
          >
            Claim @{view.name}
          </Button>
        </div>
      )}
    </AuthStage>
  );
}
