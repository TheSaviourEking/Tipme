'use client';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import type { OpsSearchResult } from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { naira } from '@/lib/money';
import { can, useOpsAccess } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Lagos',
  }).format(new Date(iso));

/** Admin search (PR-013): pages, tips, withdrawals and ledger entries. Ids and labels only. */
export default function OpsSearchPage() {
  const id = useId();
  const access = useOpsAccess();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OpsSearchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!can(access, 'search.view'))
    return (
      <Notice tone="neutral" title="Not part of your role">
        Searching needs the “search.view” permission.
      </Notice>
    );

  const find = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setError('Type at least 2 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const response = await apiFetch<OpsSearchResult>(
      `/v1/ops/search?q=${encodeURIComponent(q)}`,
    );
    setBusy(false);
    if (response.ok) setResult(response.data);
    else setError('We couldn’t search. Please try again.');
  };

  const total = result
    ? result.pages.length +
      result.tips.length +
      result.payouts.length +
      result.ledgerTransactions.length
    : 0;

  return (
    <div className="ops-dashboard">
      <h1>Search</h1>
      <p className="tm-hint">
        A handle or name, or the id or end of the reference of a tip, withdrawal
        or ledger entry. Searches are recorded in the audit log (without what
        you typed).
      </p>
      <form className="settings-form" onSubmit={(e) => void find(e)}>
        <InputField
          id={`${id}-q`}
          label="Search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          error={error || undefined}
        />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Search
        </Button>
      </form>
      {/* Only the count is announced, not every result. */}
      <p role="status" className="tm-hint">
        {result
          ? total === 0
            ? 'Nothing found.'
            : `${total} ${total === 1 ? 'result' : 'results'}.`
          : ''}
      </p>
      {result && (
        <div>
          {total === 0 ? null : (
            <>
              {result.pages.length > 0 && (
                <Card className="settings-section">
                  <h2>Pages</h2>
                  <ul className="activity-list">
                    {result.pages.map((p) => (
                      <li key={p.profileId}>
                        <Link
                          href={`/ops/pages?handle=${encodeURIComponent(p.handle)}`}
                        >
                          @{p.handle}
                        </Link>{' '}
                        · {p.displayName} · {p.plan === 'pro' ? 'Pro' : 'Free'}{' '}
                        ·{' '}
                        {p.suspended
                          ? 'Paused'
                          : p.pageState === 'live'
                            ? 'Live'
                            : 'Not live'}
                      </li>
                    ))}
                  </ul>
                  <p className="tm-hint">
                    Each page opens in Pages, where its plan can be changed.
                  </p>
                </Card>
              )}
              {result.tips.length > 0 && (
                <Card className="settings-section">
                  <h2>Tips</h2>
                  <ul className="activity-list">
                    {result.tips.map((t) => (
                      <li key={t.tipId}>
                        {naira(t.grossMinor)} to{' '}
                        {t.handle ? `@${t.handle}` : 'a deleted page'} ·{' '}
                        {t.status} · {when(t.at)} · <code>{t.tipId}</code>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {result.payouts.length > 0 && (
                <Card className="settings-section">
                  <h2>Withdrawals</h2>
                  <ul className="activity-list">
                    {result.payouts.map((o) => (
                      <li key={o.payoutId}>
                        {naira(o.amountMinor)} for{' '}
                        {o.handle ? `@${o.handle}` : 'a deleted page'} ·{' '}
                        {o.status} · {when(o.at)} · <code>{o.payoutId}</code>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {result.ledgerTransactions.length > 0 && (
                <Card className="settings-section">
                  <h2>Ledger entries</h2>
                  <ul className="activity-list">
                    {result.ledgerTransactions.map((l) => (
                      <li key={l.transactionId}>
                        {l.operationType} · {when(l.at)} ·{' '}
                        <code>{l.transactionId}</code>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
