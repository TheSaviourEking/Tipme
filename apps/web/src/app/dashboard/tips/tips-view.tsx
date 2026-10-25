'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { MyTipRow } from '@tipme/contracts';
import { Button, InputField, Skeleton } from '@tipme/ui';
import { naira } from '@/lib/money';
import { useRecipient } from '@/components/account/recipient-context';
import { apiFetch } from '@/lib/session-client';

type Filter = 'all' | 'paid' | 'confirming';
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'paid', label: 'Paid' },
  { value: 'confirming', label: 'Confirming' },
];
const stateText = {
  paid: 'Paid',
  confirming: 'Confirming',
  failed: 'Declined',
  cancelled: 'Expired',
} as const;

export default function TipsPage() {
  const id = useId();
  // An API older than PR-013 ignores the search and would list every tip as a "match".
  const { profile } = useRecipient();
  const canSearch = 'avatarPath' in profile;
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // What was actually searched: typing pauses for a moment before the list is asked again.
  const [searched, setSearched] = useState('');
  const [items, setItems] = useState<MyTipRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const listPath = (cursor?: string) =>
    `/v1/me/tips?status=${filter}${searched ? `&q=${encodeURIComponent(searched)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

  useEffect(() => {
    let current = true;
    void apiFetch<{ items: MyTipRow[]; nextCursor: string | null }>(
      listPath(),
    ).then((result) => {
      if (current && result.ok) {
        setItems(result.data.items);
        setNext(result.data.nextCursor);
      }
    });
    return () => {
      current = false;
    };
    // listPath only reads filter and searched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, searched]);

  const more = async () => {
    if (!next) return;
    const result = await apiFetch<{
      items: MyTipRow[];
      nextCursor: string | null;
    }>(listPath(next));
    if (result.ok) {
      setItems((current) => [...(current ?? []), ...result.data.items]);
      setNext(result.data.nextCursor);
    }
  };

  return (
    <div className="dashboard-section">
      <h1>Your tips</h1>
      {canSearch && (
        <InputField
          id={`${id}-search`}
          label="Search"
          type="search"
          autoComplete="off"
          hint="A supporter’s name, an amount like 2,000, or the end of a reference."
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {/* Always present, so screen readers announce a search with no results. */}
      <p role="status" className="tm-hint">
        {items && items.length === 0 && searched
          ? `No tips match “${searched}”.`
          : ''}
      </p>
      <div className="filter-row" role="group" aria-label="Show">
        {filters.map((option) => (
          <Button
            key={option.value}
            variant={filter === option.value ? 'primary' : 'secondary'}
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {!items ? (
        <Skeleton label="Loading your tips" />
      ) : items.length === 0 ? (
        searched ? null : (
          <p>No tips here yet.</p>
        )
      ) : (
        <ul className="activity-list">
          {items.map((tip) => (
            <li key={tip.tipId}>
              <Link
                href={`/dashboard/tips/${tip.tipId}`}
                className="activity-list__row"
              >
                <span>
                  Tip from {tip.supporterLabel ?? 'a guest'}
                  {tip.hasMessage && (
                    <span className="tm-hint"> · with a note</span>
                  )}
                  <small>
                    {new Date(tip.at).toLocaleString('en-NG', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'Africa/Lagos',
                    })}
                  </small>
                </span>
                <span className="activity-list__amount">
                  {naira(tip.netMinor)}{' '}
                  <span className={`status-tag status-tag--${tip.state}`}>
                    {stateText[tip.state]}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Button variant="secondary" onClick={() => void more()}>
          Show more
        </Button>
      )}
    </div>
  );
}
