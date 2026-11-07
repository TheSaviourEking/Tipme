'use client';
import { useEffect, useId, useState } from 'react';
import type { BusinessDetail, MemberRow } from '@tipme/contracts';
import { Button, EmptySlip, Skeleton, Slip, StateLine } from '@tipme/ui';
import { setMemberShift, shiftProblem } from '@/lib/business/shifts-api';
import { apiFetch } from '@/lib/session-client';

/**
 * Business → On today (PR B6): a manager checks people in and out. One switch per person; on
 * shift, they are listed first on their location's page. The team comes from B3's members list,
 * scoped by the server to what this manager may see.
 */
export function OnTodayCard({ business }: { business: BusinessDetail }) {
  // Kept with the business and attempt it belongs to, so a retry or a switch shows loading.
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    members: MemberRow[] | 'failed';
  } | null>(null);
  const key = `${business.id}:${attempt}`;
  useEffect(() => {
    let live = true;
    void apiFetch<MemberRow[]>(`/v1/me/businesses/${business.id}/members`).then(
      (result) => {
        if (live)
          setLoaded({
            key,
            members:
              result.ok && Array.isArray(result.data) ? result.data : 'failed',
          });
      },
    );
    return () => {
      live = false;
    };
  }, [business.id, key]);
  const members = loaded?.key === key ? loaded.members : null;
  const load = () => setAttempt((n) => n + 1);

  if (members === null) return <Skeleton label="Loading your team" />;
  if (members === 'failed')
    return (
      <Slip
        tone="error"
        title="We couldn’t load your team."
        actions={
          <Button variant="secondary" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  if (members.length === 0)
    return (
      <EmptySlip title="Nobody works here on TipMe yet.">
        <p>When someone joins, you can check them in here.</p>
      </EmptySlip>
    );
  const several = business.locations.length > 1;
  const placeOf = (locationId: string) =>
    business.locations.find((location) => location.id === locationId)?.name;
  const canStart = business.status === 'verified';
  return (
    <ul className="on-today" data-testid="on-today">
      {members.map((member) => (
        <OnTodayRow
          key={member.memberId}
          businessId={business.id}
          member={member}
          place={several ? placeOf(member.locationId) : undefined}
          canStart={canStart}
        />
      ))}
    </ul>
  );
}

function OnTodayRow({
  businessId,
  member,
  place,
  canStart,
}: {
  businessId: string;
  member: MemberRow;
  place: string | undefined;
  canStart: boolean;
}) {
  const fieldId = useId();
  const [on, setOn] = useState(member.onShift);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const change = async (next: boolean) => {
    // The switch moves at once; the server's answer then sets it, or puts it back.
    setOn(next);
    setBusy(true);
    setProblem('');
    const result = await setMemberShift(businessId, member.memberId, next);
    setBusy(false);
    if (result.ok) setOn(result.data.onShift);
    else {
      setOn(!next);
      setProblem(shiftProblem(result));
    }
  };
  return (
    <li className="on-today__row">
      <span className="on-today__who">
        <strong>{member.shownName}</strong>
        {place && <small>{place}</small>}
      </span>
      <label className="tip-remember on-today__switch" htmlFor={fieldId}>
        <input
          id={fieldId}
          type="checkbox"
          role="switch"
          checked={on}
          disabled={!on && !canStart}
          aria-busy={busy}
          aria-describedby={problem ? `${fieldId}-problem` : undefined}
          onChange={(event) => {
            if (!busy) void change(event.target.checked);
          }}
        />
        <span>
          <span className="sr-only">{member.shownName} </span>On today
        </span>
      </label>
      <StateLine tone="error" id={`${fieldId}-problem`}>
        {problem}
      </StateLine>
    </li>
  );
}
