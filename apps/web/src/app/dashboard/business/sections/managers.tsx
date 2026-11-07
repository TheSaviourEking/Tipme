'use client';
import { useCallback, useEffect, useState } from 'react';
import type { BusinessDetail, ManagerRow } from '@tipme/contracts';
import { Button, Skeleton, StateLine } from '@tipme/ui';
import { listManagers, removeManager } from '@/lib/business/setup-api';

const roleWords = (row: ManagerRow, business: BusinessDetail) => {
  if (row.role === 'owner') return 'Owner, all locations';
  const location = business.locations.find((l) => l.id === row.locationId);
  return location ? `Manager, ${location.name}` : 'Location manager';
};

/**
 * Section "Managers" (PR B1). Every manager sees the list; owners remove (never the last owner).
 * Adding one is an invitation (PR B3), so until that ships the card says how it will work.
 */
export function ManagersCard({ business }: { business: BusinessDetail }) {
  const owner = business.you.role === 'owner';
  const [rows, setRows] = useState<ManagerRow[] | null | undefined>(undefined);
  const [removing, setRemoving] = useState<string | null>(null);
  const [said, say] = useState<{ tone: 'error' | 'status'; text: string }>({
    tone: 'status',
    text: '',
  });
  const load = useCallback(
    () =>
      void listManagers(business.id).then((result) =>
        setRows(result.ok ? result.data : null),
      ),
    [business.id],
  );
  useEffect(load, [load]);

  const remove = async (row: ManagerRow) => {
    const result = await removeManager(business.id, row.managerId);
    setRemoving(null);
    if (result.ok) {
      say({
        tone: 'status',
        text: `${row.name} no longer manages ${business.name}.`,
      });
      load();
      return;
    }
    say({
      tone: 'error',
      text:
        result.code === 'BUSINESS_LAST_OWNER'
          ? `Make someone else an owner of ${business.name} first, or close it.`
          : `${row.name} wasn’t removed. Try again in a moment.`,
    });
  };

  if (rows === undefined) return <Skeleton label="Loading managers" />;
  if (rows === null)
    return (
      <StateLine tone="error">
        The managers didn’t load. Reload the page to try again.
      </StateLine>
    );
  return (
    <div className="business-managers">
      <ul className="business-managers__list">
        {rows.map((row) => (
          <li key={row.managerId} className="business-manager">
            <div className="business-manager__text">
              <strong>
                {row.name}
                {row.you ? ' (you)' : ''}
              </strong>
              <span>{roleWords(row, business)}</span>
            </div>
            {owner &&
              (removing === row.managerId ? (
                <div
                  className="business-manager__confirm"
                  role="group"
                  aria-label={`Remove ${row.name}?`}
                >
                  <p>
                    {row.you
                      ? `You’ll stop managing ${business.name}.`
                      : `${row.name} will stop managing ${business.name}.`}
                  </p>
                  <div className="business-location__keys">
                    <Button
                      variant="secondary"
                      onClick={() => void remove(row)}
                    >
                      Remove {row.you ? 'me' : row.name}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setRemoving(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  aria-label={`Remove ${row.name}`}
                  onClick={() => setRemoving(row.managerId)}
                >
                  Remove
                </Button>
              ))}
          </li>
        ))}
      </ul>
      <p className="tm-hint">
        Owners manage every location; a location manager looks after one. You
        add managers by inviting them with their own TipMe account.
      </p>
      <StateLine tone={said.tone}>{said.text}</StateLine>
    </div>
  );
}
