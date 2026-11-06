'use client';
import { useState } from 'react';
import type { MyMembership } from '@tipme/contracts';
import { ResultKey, StateLine, useKeyResult } from '@tipme/ui';
import {
  setOwnShift,
  shiftClock,
  shiftProblem,
} from '@/lib/business/shifts-api';

/**
 * Work → On shift (PR B6): check in and out at this membership's location. While on shift the
 * person is listed first on the location page; a shift ends by itself after 14 hours.
 */
export function ShiftCard({ membership }: { membership: MyMembership }) {
  const [startedAt, setStartedAt] = useState<string | null>(
    membership.onShift ? (membership.shiftStartedAt ?? null) : null,
  );
  const [onShift, setOnShift] = useState(membership.onShift);
  const [problem, setProblem] = useState('');
  const key = useKeyResult({ onRetry: () => void press() });
  const location = membership.location.name;
  const open = membership.business.status === 'verified';

  async function press() {
    const next = !onShift;
    key.start();
    setProblem('');
    const result = await setOwnShift(membership.memberId, next);
    if (!result.ok) {
      setProblem(shiftProblem(result));
      key.failed({
        label: next ? 'Not checked in' : 'Not checked out',
        retryLabel: 'Try again',
      });
      return;
    }
    setOnShift(result.data.onShift);
    setStartedAt(result.data.startedAt ?? null);
    key.done(result.data.onShift ? 'Checked in' : 'Checked out');
  }

  return (
    <div className="work-shift" data-testid="work-shift">
      <p className="work-shift__state" role="status">
        {onShift
          ? startedAt
            ? `You’re on at ${location} since ${shiftClock(startedAt)}.`
            : `You’re on at ${location}.`
          : open
            ? 'You’re not on shift.'
            : 'This business isn’t taking tips on TipMe right now, so you can’t check in.'}
      </p>
      {(onShift || open) && (
        <ResultKey
          variant={onShift ? 'secondary' : 'primary'}
          result={key.result}
          pending={key.pending}
          onClick={() => void press()}
        >
          {onShift ? 'Check out' : `Check in at ${location}`}
        </ResultKey>
      )}
      <p className="tm-hint">
        On shift, you’re listed first on {location}’s page. A shift ends by
        itself after 14 hours.
      </p>
      <StateLine tone="error">{problem}</StateLine>
    </div>
  );
}
