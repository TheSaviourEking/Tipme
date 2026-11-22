'use client';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { CollectStatusView, DashboardSummary } from '@tipme/contracts';
import { COLLECT_COPY } from '@tipme/contracts/copy';
import { usePanel } from '@/components/dashboard/use-panel';
import { Money } from '@/components/money';

/**
 * You collect (plan Task 14, spec §2.1): the signed-in recipient's collect state, from
 * `GET /v1/me/collect`. Only a 404 means "not on You collect" (`direct`): a page then shows exactly
 * what it showed before. Any other failure before a first answer (a 429, 5xx, time limit or no
 * connection) is `failed`, never read as direct, so a collect recipient is never shown today's
 * screens by mistake. After a first answer, a failed re-read keeps it.
 */
export function useCollectStatus(): {
  collect: CollectStatusView | null;
  /** The read answered: the status arrived, or a 404 said they are not on You collect. */
  known: boolean;
  /** No answer yet, and the last read failed with anything but a 404. */
  failed: boolean;
  reload: () => Promise<void>;
} {
  // A tip changes what is kept, a check that ends writes a notification, and a withdrawal ends
  // the first-withdrawal cap.
  const panel = usePanel<CollectStatusView>('/v1/me/collect', {
    live: [
      'tips.changed',
      'payments.changed',
      'notifications.changed',
      'withdrawals.changed',
    ],
  });
  const collect = panel.data?.mode === 'collect' ? panel.data : null;
  const direct = panel.data === null && panel.failedStatus === 404;
  return {
    collect,
    known: panel.data !== null || direct,
    failed:
      panel.data === null &&
      panel.failedStatus !== null &&
      panel.failedStatus !== 404,
    reload: panel.reload,
  };
}

/**
 * A §10 sentence that takes an amount, with the amount in the money face: the words stay
 * COLLECT_COPY's own, and only the amount is a Money.
 */
export function withAmount(
  sentence: (amount: string) => string,
  minor: string,
): ReactNode {
  const mark = '\u0000';
  const [before = '', after = ''] = sentence(mark).split(mark);
  return (
    <Fragment>
      {before}
      <Money minor={minor} />
      {after}
    </Fragment>
  );
}

/**
 * What TipMe holds for a collect recipient beside their balance: kept until they add bank details,
 * or on its way once verified. Neither is withdrawable. Both are "0" for everyone else, so nothing
 * shows for them.
 */
export function CollectHeldNotes({
  summary,
  className,
}: {
  summary: Pick<DashboardSummary, 'keptMinor' | 'onItsWayMinor'>;
  className: string;
}) {
  return (
    <>
      {summary.keptMinor !== '0' && (
        <span className={className} data-testid="kept">
          <Money minor={summary.keptMinor} /> {COLLECT_COPY.balanceNote}
        </span>
      )}
      {summary.onItsWayMinor !== '0' && (
        <span className={className} data-testid="on-its-way">
          {COLLECT_COPY.onItsWay} <Money minor={summary.onItsWayMinor} />
        </span>
      )}
    </>
  );
}
