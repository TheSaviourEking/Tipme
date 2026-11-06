'use client';
import { useEffect, useState } from 'react';
import type { WhatsNewList } from '@tipme/contracts';
import { EmptySlip, Skeleton, Slip } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';
import { groupByDay, newestLiveAt } from '@/lib/whats-new';
import { useWhatsNew } from '@/components/dashboard/whats-new-context';

/**
 * What's new (changelog plan, Design §6): the approved updates live in production, newest first,
 * under the day each went live (Lagos). Opening it marks them seen on every device.
 */
export default function WhatsNewPage() {
  const { markSeen } = useWhatsNew();
  const [list, setList] = useState<WhatsNewList | null | 'error'>(null);

  useEffect(() => {
    void apiFetch<WhatsNewList>('/v1/me/whats-new').then((result) => {
      if (result.ok) setList(result.data);
      // An API from before What's new has nothing to show yet.
      else if (result.status === 404) setList({ entries: [], unseen: 0 });
      else setList('error');
    });
  }, []);

  const through = list && list !== 'error' ? newestLiveAt(list.entries) : null;
  const unseen = list && list !== 'error' ? list.unseen : 0;
  useEffect(() => {
    if (through && unseen > 0) void markSeen(through);
  }, [through, unseen, markSeen]);

  return (
    <section className="whats-new" aria-labelledby="whats-new-title">
      <h1 id="whats-new-title">What’s new</h1>
      {list === null ? (
        <Skeleton label="Loading what’s new" />
      ) : list === 'error' ? (
        <Slip tone="error" title="We couldn’t load what’s new">
          Please reload the page.
        </Slip>
      ) : list.entries.length === 0 ? (
        <EmptySlip title="Nothing new yet">
          Updates to TipMe will show here.
        </EmptySlip>
      ) : (
        groupByDay(list.entries).map((day) => (
          <section
            key={day.liveOn}
            className="whats-new__day"
            aria-labelledby={`whats-new-${day.liveOn}`}
          >
            <h2 id={`whats-new-${day.liveOn}`} className="whats-new__date">
              <time dateTime={day.liveOn}>{day.label}</time>
            </h2>
            <ul className="whats-new__list">
              {day.entries.map((entry) => (
                <li key={entry.number} className="whats-new__entry">
                  <p>{entry.line}</p>
                  {entry.pro && <span className="whats-new__pro">Pro</span>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
