import Link from 'next/link';
import type { ActivityRow } from '@tipme/contracts';
import { naira } from '@/lib/money';

const stateText: Record<string, string> = {
  paid: 'Paid',
  confirming: 'Confirming',
  requested: 'Requested',
  processing: 'Processing',
  in_review: 'Being checked by the payment provider',
  sent: 'Sent',
  failed: 'Failed',
  reversed: 'Reversed',
};
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Lagos',
  });

const NONE: ReadonlySet<string> = new Set();

/**
 * `arriving`: ids of new paid tips, which come down once (no motion under reduced motion).
 * `highlighted`: ids just confirmed, highlighted in place. Rows keep their keys, so focus stays.
 */
export function ActivityList({
  rows,
  arriving = NONE,
  highlighted = NONE,
}: {
  rows: ActivityRow[];
  arriving?: ReadonlySet<string>;
  highlighted?: ReadonlySet<string>;
}) {
  return (
    <ul className="activity-list">
      {rows.map((row) => {
        const body = (
          <>
            <span>
              {row.kind === 'tip'
                ? `Tip from ${row.supporterLabel ?? 'a guest'}`
                : 'Withdrawal'}
              <small>
                {row.state === 'confirming' ? 'Being confirmed' : when(row.at)}
              </small>
            </span>
            <span
              className={`activity-list__amount${row.state === 'confirming' ? ' activity-list__amount--pending' : ''}`}
            >
              {row.kind === 'withdrawal' ? '−' : ''}
              {naira(row.amountMinor)}{' '}
              <span className={`status-tag status-tag--${row.state}`}>
                {stateText[row.state] ?? row.state}
              </span>
            </span>
          </>
        );
        const tipRow = row.kind === 'tip';
        const rowClass = [
          'activity-list__row',
          tipRow && arriving.has(row.id) ? 'activity-list__row--arriving' : '',
          tipRow && highlighted.has(row.id)
            ? 'activity-list__row--highlighted'
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li key={`${row.kind}-${row.id}`}>
            {row.kind === 'tip' ? (
              <Link href={`/dashboard/tips/${row.id}`} className={rowClass}>
                {body}
              </Link>
            ) : (
              <div className="activity-list__row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
