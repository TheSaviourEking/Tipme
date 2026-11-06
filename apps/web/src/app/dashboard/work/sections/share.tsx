'use client';
import { useId, useState } from 'react';
import type { MyMembership } from '@tipme/contracts';
import { StateLine } from '@tipme/ui';
import { saveShareAmounts } from '@/lib/business/insights-api';

/**
 * Work → share (PR B7): the person chooses whether the business sees their weekly tip total.
 * Off by default; the business never sees a single tip's amount.
 */
export function ShareCard({ membership }: { membership: MyMembership }) {
  const id = useId();
  const [share, setShare] = useState(membership.shareAmounts);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'saved' | 'failed' | null>(null);
  const business = membership.business.name;
  return (
    <div className="work-share">
      <div className="tip-remember">
        <input
          id={`${id}-share`}
          type="checkbox"
          role="switch"
          checked={share}
          disabled={busy}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const next = event.target.checked;
            // Shown at once; put back if the save fails.
            setShare(next);
            setBusy(true);
            setState(null);
            void saveShareAmounts(membership.memberId, next).then((result) => {
              setBusy(false);
              if (result.ok) {
                setShare(result.data.shareAmounts);
                setState('saved');
              } else {
                setShare(!next);
                setState('failed');
              }
            });
          }}
        />
        <span>
          <label htmlFor={`${id}-share`}>
            Show my tip amounts to {business}
          </label>
          <small id={`${id}-hint`}>
            They see your weekly total only, and only in weeks with 3 or more
            tips. Turning this on shows the business your amounts for past weeks
            too. Turn it off any time.
          </small>
        </span>
      </div>
      {state === 'failed' ? (
        <StateLine tone="error">
          We couldn’t save that. Please try again.
        </StateLine>
      ) : (
        <StateLine tone="status">
          {state === 'saved'
            ? share
              ? `${business} can see your weekly total.`
              : `${business} sees counts only.`
            : ''}
        </StateLine>
      )}
    </div>
  );
}
