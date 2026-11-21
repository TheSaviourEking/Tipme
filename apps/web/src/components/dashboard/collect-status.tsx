'use client';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { CollectStatusView, DashboardSummary } from '@tipme/contracts';
import { COLLECT_COPY } from '@tipme/contracts';
import { usePanel } from '@/components/dashboard/use-panel';
import { Money } from '@/components/money';

/**
 * You collect (plan Task 14, spec §2.1): the signed-in recipient's collect state, from
 * `GET /v1/me/collect`. Anyone not on You collect is answered 404 there, and any failure reads the
 * same: `collect` stays null, so a page shows exactly what it showed before. `known` is false only
 * until the first answer, so a page can wait rather than flash today's screen at a collect recipient.
 */
export function useCollectStatus(): {
  collect: CollectStatusView | null;
  known: boolean;
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
  return {
    collect,
    known: panel.data !== null || panel.failedStatus !== null,
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
