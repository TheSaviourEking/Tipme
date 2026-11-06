'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { LiveEventType, MyTipRow, TipTotals } from '@tipme/contracts';
import { Button, InputField, Notice, Skeleton } from '@tipme/ui';
import { formatNaira } from '@/lib/demo-amount';
import { dayKey, timeOf } from '@/lib/lagos-time';
import { useRecipient } from '@/components/account/recipient-context';
import { usePanel } from '@/components/dashboard/use-panel';
import { useLiveEvents } from '@/components/live/live-provider';
import { canInsertInPlace } from '@/lib/live-merge';

const TIPS_CHANGED: readonly LiveEventType[] = ['tips.changed'];
const NO_SIGNALS: readonly LiveEventType[] = [];
import { apiDownload, apiFetch } from '@/lib/session-client';

type Filter = 'all' | 'notes' | 'confirming';
// "With a note" asks only for paid tips: a note's words reach the recipient with a paid tip.
const filterQuery: Record<Filter, string> = {
  all: 'status=all',
  notes: 'status=paid&note=with',
  confirming: 'status=confirming',
};
type Page = { items: MyTipRow[]; nextCursor: string | null };
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'notes', label: 'With a note' },
  { value: 'confirming', label: 'Being confirmed' },
];
// A paid tip says nothing extra; any other state is said in words, never by colour alone.
const stateText = {
  confirming: 'Being confirmed',
  failed: 'Declined',
  cancelled: 'Expired',
} as const;

function dayTitle(key: string, now: number) {
  if (key === dayKey(new Date(now).toISOString())) return 'Today';
  if (key === dayKey(new Date(now - 86_400_000).toISOString()))
    return 'Yesterday';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Rows grouped by Lagos day, newest first, keeping the API's order. */
function byDay(items: MyTipRow[]) {
  const days: { key: string; rows: MyTipRow[] }[] = [];
  for (const tip of items) {
    const key = dayKey(tip.at);
    const last = days[days.length - 1];
    if (last?.key === key) last.rows.push(tip);
    else days.push({ key, rows: [tip] });
  }
  return days;
}

export default function TipsPage() {
  const id = useId();
  // An API older than PR-013 ignores the search and would list every tip as a "match".
  const { profile } = useRecipient();
  const canSearch = 'avatarPath' in profile;
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // What was actually searched: typing pauses for a moment before the list is asked again.
  const [searched, setSearched] = useState('');
  const [download, setDownload] = useState('');
  // Later pages, kept with the list they belong to so a new search drops them.
  const [more, setMore] = useState<{
    path: string;
    items: MyTipRow[];
    next: string | null;
  } | null>(null);
  const [now] = useState(() => Date.now());

  // Typing waits for a pause.
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const listPath = (cursor?: string) =>
    `/v1/me/tips?${filterQuery[filter]}${searched ? `&q=${encodeURIComponent(searched)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const path = listPath();
  const extra = more?.path === path ? more : null;
  // Only the first page refreshes in place. Someone searching or further down the list gets a
  // "New tips: show" button instead of rows inserted under them.
  const inPlace = canInsertInPlace({ searched, extraPages: extra ? 1 : 0 });
  // One loader: data, error and reload(). A failed refresh keeps the rows already shown.
  const { data, error, reload } = usePanel<Page>(path, {
    live: inPlace ? TIPS_CHANGED : NO_SIGNALS,
    resync: inPlace,
  });
  // What was received in all, from the API. Hidden until it is known; a failed refresh keeps it.
  // A new paid tip changes it, wherever the reader is in the list.
  const totals = usePanel<TipTotals>('/v1/me/tip-totals', {
    live: TIPS_CHANGED,
  });
  const [newTips, setNewTips] = useState(false);
  useLiveEvents(
    inPlace ? NO_SIGNALS : TIPS_CHANGED,
    async () => setNewTips(true),
    { resync: false },
  );
  const showNewTips = () => {
    setNewTips(false);
    setMore(null);
    setQuery('');
    setSearched('');
    // Clearing a search changes the path, and the panel reads the new one itself; only a deeper
    // list of the same path needs asking again (a read of the old path would be thrown away).
    if (!searched) void reload();
  };
  const items = data ? [...data.items, ...(extra?.items ?? [])] : null;
  const next = extra ? extra.next : (data?.nextCursor ?? null);

  const showMore = async () => {
    if (!next) return;
    const result = await apiFetch<Page>(listPath(next));
    if (result.ok)
      setMore({
        path,
        items: [...(extra?.items ?? []), ...result.data.items],
        next: result.data.nextCursor,
      });
  };

  if (error === 'load' && !data)
    return (
      <Notice tone="error" title="We couldn’t load your tips">
        Please reload the page.
      </Notice>
    );

  return (
    <div className="dashboard-section tips-page">
      <header className="tips-head">
        <div>
          <h1>Your tips</h1>
          {totals.data && totals.data.paidTipCount > 0 && (
            <p className="tm-hint">
              {formatNaira(totals.data.receivedNetMinor)} from{' '}
              {totals.data.paidTipCount}{' '}
              {totals.data.paidTipCount === 1 ? 'tip' : 'tips'} so far
            </p>
          )}
        </div>
        <Button
          variant="quiet"
          onClick={async () => {
            setDownload('Preparing your file…');
            const day = new Date().toISOString().slice(0, 10);
            const result = await apiDownload(
              '/v1/me/exports/tips.csv',
              `tipme-tips-${day}.csv`,
            );
            setDownload(
              result.ok
                ? 'Downloaded. It has the date, supporter name, amounts, status and the last 6 characters of each reference. Messages stay private.'
                : 'We couldn’t prepare the file. Please try again.',
            );
          }}
        >
          Download as CSV
        </Button>
      </header>
      <p role="status" className="tm-hint tips-status">
        {download}
      </p>
      <div className="tips-controls">
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
        <div className="filter-row" role="group" aria-label="Show">
          {filters.map((option) => (
            <Button
              key={option.value}
              variant={filter === option.value ? 'primary' : 'secondary'}
              aria-pressed={filter === option.value}
              onClick={() => {
                setFilter(option.value);
                // New tips may have arrived since the header was read.
                void totals.reload();
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {/* Always present, so screen readers announce a search with no results. */}
      <p role="status" className="tm-hint">
        {items && items.length === 0 && searched
          ? `No tips match “${searched}”.`
          : ''}
        {error === 'refresh' ? 'Couldn’t refresh' : ''}
      </p>
      {newTips && !inPlace && (
        <p className="tips-new">
          <Button variant="secondary" onClick={showNewTips}>
            New tips: show
          </Button>
        </p>
      )}
      {!items ? (
        <Skeleton label="Loading your tips" />
      ) : items.length === 0 ? (
        searched ? null : (
          <p>No tips here yet.</p>
        )
      ) : (
        byDay(items).map((day) => {
          const title = dayTitle(day.key, now);
          return (
            <section key={day.key} aria-label={title} className="tips-day">
              <h2>{title}</h2>
              <ul className="tips-list">
                {day.rows.map((tip) => (
                  <li key={tip.tipId}>
                    <Link
                      href={`/dashboard/tips/${tip.tipId}`}
                      className="tip-row"
                      data-state={tip.state}
                    >
                      <span className="tip-row__who">
                        <strong>
                          <span className="sr-only">Tip from </span>
                          {tip.supporterLabel ?? 'Anonymous'}
                        </strong>
                        <small>
                          {timeOf(tip.at)}
                          {tip.hasMessage && ' · with a note'}
                          {tip.state !== 'paid' && (
                            <span className="tip-row__state">
                              {' · '}
                              {stateText[tip.state]}
                            </span>
                          )}
                        </small>
                      </span>
                      <span className="tip-row__money">
                        <strong>{formatNaira(Number(tip.netMinor))}</strong>
                        <small>
                          from {formatNaira(Number(tip.grossMinor))}
                        </small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {next && (
        <Button variant="secondary" onClick={() => void showMore()}>
          Show more
        </Button>
      )}
    </div>
  );
}
