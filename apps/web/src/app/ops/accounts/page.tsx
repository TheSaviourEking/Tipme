'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { OpsAccountRow } from '@tipme/contracts';
import { InputField, Skeleton } from '@tipme/ui';
import { when } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

/** Find a recipient by handle (current or old) or name. Phone and email are not searchable. */
export default function OpsAccountsPage() {
  const id = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{
    term: string;
    rows: OpsAccountRow[];
  } | null>(null);
  const term = query.trim();

  useEffect(() => {
    if (!term) return;
    let current = true;
    const timer = setTimeout(() => {
      void apiFetch<OpsAccountRow[]>(
        `/v1/ops/accounts?q=${encodeURIComponent(term)}`,
      ).then((result) => {
        if (current) setSearch({ term, rows: result.ok ? result.data : [] });
      });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term]);

  const rows = term ? (search?.term === term ? search.rows : null) : [];

  return (
    <div className="dashboard-section">
      <h1>Accounts</h1>
      <div className="tips-search" role="search">
        <InputField
          id={`${id}-q`}
          label="Find a recipient"
          type="search"
          autoComplete="off"
          maxLength={60}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          hint="Handle (including an old one) or name. Phone numbers and emails stay private."
        />
      </div>
      {rows === null ? (
        <Skeleton label="Searching" />
      ) : term && rows.length === 0 ? (
        <p>No recipients match “{term}”.</p>
      ) : (
        <ul className="activity-list">
          {rows.map((row) => (
            <li key={row.profileId}>
              <Link
                className="activity-list__row"
                href={`/ops/accounts/${row.profileId}`}
              >
                <span>
                  {row.displayName} · @{row.handle}
                  <small>Joined {when(row.createdAt)}</small>
                </span>
                <span className="activity-list__amount">
                  <span
                    className={`status-tag status-tag--${row.status === 'suspended' ? 'failed' : row.pageState === 'live' ? 'paid' : 'confirming'}`}
                  >
                    {row.status === 'suspended'
                      ? 'Paused by TipMe'
                      : row.pageState === 'live'
                        ? 'Live'
                        : 'Not live'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
