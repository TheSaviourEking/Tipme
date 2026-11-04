'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ActionLink, Button, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

// Named as the settings page names them.
const NAMES: Record<string, string> = {
  tip_received: 'emails about each tip',
  weekly_report: 'weekly report emails',
  milestone: 'milestone emails',
};

/** Asks first: mail scanners open every link, and opening this one must change nothing. */
export function UnsubscribeConfirm() {
  const token = useSearchParams().get('t') ?? '';
  const [state, setState] = useState<
    'ask' | 'busy' | 'done' | 'invalid' | 'failed'
  >(token ? 'ask' : 'invalid');
  const [type, setType] = useState('');
  const turnOff = async () => {
    setState('busy');
    const result = await apiFetch<{ type: string }>(
      `/v1/mail/unsubscribe?t=${encodeURIComponent(token)}`,
      { method: 'POST', body: {} },
    );
    if (result.ok) {
      setType(result.data.type);
      setState('done');
    } else
      setState(result.code === 'UNSUBSCRIBE_INVALID' ? 'invalid' : 'failed');
  };
  const settings = (
    <p className="auth-switch">
      Change any email in{' '}
      <Link href="/dashboard/settings#emails">your settings</Link>.
    </p>
  );
  if (state === 'done')
    return (
      <div className="confirm-body" role="status">
        <h2 className="confirm-title">You’re unsubscribed.</h2>
        <p>
          You won’t get {NAMES[type] ?? 'guides and suggestions'} any more.
          Security emails will still reach you, because they protect your
          account.
        </p>
        <ActionLink variant="secondary" href="/dashboard/settings#emails">
          Manage your emails
        </ActionLink>
      </div>
    );
  if (state === 'invalid')
    return (
      <>
        <Notice tone="error" title="This link doesn’t work">
          It may have been copied wrongly.
        </Notice>
        {settings}
      </>
    );
  return (
    <div className="auth-form">
      {state === 'failed' && (
        <Notice tone="error" title="That didn’t go through">
          Please try again.
        </Notice>
      )}
      <Button
        variant="continue"
        onClick={() => void turnOff()}
        disabled={state === 'busy'}
      >
        Turn off this email
      </Button>
      {settings}
    </div>
  );
}
