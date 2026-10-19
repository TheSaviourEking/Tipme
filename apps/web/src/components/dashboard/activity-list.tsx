import Link from 'next/link';
import type { ActivityRow } from '@tipme/contracts';
import { naira } from '@/lib/money';

const stateText: Record<string, string> = {
  paid: 'Paid',
  confirming: 'Confirming',
  requested: 'Requested',
  processing: 'Processing',
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

export function ActivityList({ rows }: { rows: ActivityRow[] }) {
  return (
    <ul className="activity-list">
      {rows.map((row) => {
        const body = (
          <>
            <span>
              {row.kind === 'tip'
                ? `Tip from ${row.supporterLabel ?? 'a guest'}`
                : 'Withdrawal'}
              <small>{when(row.at)}</small>
            </span>
            <span className="activity-list__amount">
              {row.kind === 'withdrawal' ? '−' : ''}
              {naira(row.amountMinor)}{' '}
              <span className={`status-tag status-tag--${row.state}`}>
                {stateText[row.state] ?? row.state}
              </span>
            </span>
          </>
        );
        return (
          <li key={`${row.kind}-${row.id}`}>
            {row.kind === 'tip' ? (
              <Link
                href={`/dashboard/tips/${row.id}`}
                className="activity-list__row"
              >
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
