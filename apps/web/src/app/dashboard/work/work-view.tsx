'use client';
import { useCallback, useEffect, useState } from 'react';
import type { MyMembership } from '@tipme/contracts';
import { EmptySlip, Skeleton, StateLine } from '@tipme/ui';
import { loadWork, WORK_CHANGED } from '@/lib/business/members-api';
import { InvitationsPanel } from './sections/invitations';
import { WORK_SECTIONS } from './sections';

/**
 * The Work page: invitations waiting for this account (B3), then each place the signed-in
 * person's page works, with every lane's card drawn per membership from the registry.
 */
export function WorkView() {
  const [memberships, setMemberships] = useState<
    MyMembership[] | null | undefined
  >(undefined);

  const reload = useCallback(() => {
    void loadWork().then((result) =>
      setMemberships(
        result.ok && Array.isArray(result.data) ? result.data : null,
      ),
    );
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener(WORK_CHANGED, reload);
    return () => window.removeEventListener(WORK_CHANGED, reload);
  }, [reload]);

  return (
    <div className="dashboard-section work-page">
      <header className="work-page__head">
        <h1>Work</h1>
      </header>
      <InvitationsPanel />
      {memberships === undefined ? (
        <Skeleton label="Loading where you work" />
      ) : memberships === null ? (
        <StateLine tone="error">
          We couldn’t load where you work just now. Please try again.
        </StateLine>
      ) : memberships.length === 0 ? (
        <EmptySlip title="You don’t work anywhere on TipMe yet.">
          <p>When a business invites you, it shows here.</p>
        </EmptySlip>
      ) : (
        memberships.map((membership) => (
          <section
            key={membership.memberId}
            aria-labelledby={`work-${membership.memberId}`}
            className="work-membership"
          >
            <h2 id={`work-${membership.memberId}`}>
              {membership.business.name} · {membership.location.name}
            </h2>
            {WORK_SECTIONS.map(({ id, title, Card }) => (
              <section key={id} className="work-section">
                <h3>{title}</h3>
                <Card membership={membership} />
              </section>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
