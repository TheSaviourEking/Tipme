'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  ActionLink,
  ResultKey,
  Slip,
  StateLine,
  useKeyResult,
} from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

// Named as the settings page names them.
const NAMES: Record<string, string> = {
  tip_received: 'emails about each tip',
  weekly_report: 'weekly report emails',
  milestone: 'milestone emails',
  announcement: 'news and announcements',
};

/** Asks first: mail scanners open every link, and opening this one must change nothing. */
export function UnsubscribeConfirm() {
  const token = useSearchParams().get('t') ?? '';
  const [state, setState] = useState<'ask' | 'done' | 'invalid'>(
    token ? 'ask' : 'invalid',
  );
  const [type, setType] = useState('');
  // One click's refusal: the key says it (Concept B), with one plain line under it.
  const key = useKeyResult({ onRetry: () => void turnOff() });
  const turnOff = async () => {
    if (key.pending) return;
    key.start();
    const result = await apiFetch<{ type: string }>(
      `/v1/mail/unsubscribe?t=${encodeURIComponent(token)}`,
      { method: 'POST', body: {} },
    );
    if (result.ok) {
      key.clear();
      setType(result.data.type);
      setState('done');
    } else if (result.code === 'UNSUBSCRIBE_INVALID') {
      key.clear();
      setState('invalid');
    } else
      key.failed({ label: 'That didn’t go through', retryLabel: 'Try again' });
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
        <Slip tone="error" title="This link doesn’t work">
          It may have been copied wrongly.
        </Slip>
        {settings}
      </>
    );
  return (
    <div className="auth-form">
      <ResultKey
        variant="continue"
        onClick={() => void turnOff()}
        result={key.result}
        pending={key.pending}
      >
        Turn off this email
      </ResultKey>
      <StateLine tone="error">
        {key.result?.kind === 'failed' ? 'Please try again.' : ''}
      </StateLine>
      {settings}
    </div>
  );
}
