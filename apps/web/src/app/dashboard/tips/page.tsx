'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MyTipRow } from '@tipme/contracts';
import { Button, Skeleton } from '@tipme/ui';
import { naira } from '@/lib/money';
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
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<MyTipRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ items: MyTipRow[]; nextCursor: string | null }>(
      `/v1/me/tips?status=${filter}`,
    ).then((result) => {
      if (result.ok) {
        setItems(result.data.items);
        setNext(result.data.nextCursor);
      }
    });
  }, [filter]);

  const more = async () => {
    if (!next) return;
    const result = await apiFetch<{
      items: MyTipRow[];
      nextCursor: string | null;
    }>(`/v1/me/tips?status=${filter}&cursor=${encodeURIComponent(next)}`);
    if (result.ok) {
      setItems((current) => [...(current ?? []), ...result.data.items]);
      setNext(result.data.nextCursor);
    }
  };

  return (
    <div className="dashboard-section">
      <h1>Your tips</h1>
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
        <p>No tips here yet.</p>
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
