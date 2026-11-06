'use client';
import { useEffect, useState } from 'react';
import type { MyBusinessRoles, MyMembership } from '@tipme/contracts';
import { EmptySlip, Skeleton } from '@tipme/ui';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { apiFetch } from '@/lib/session-client';
import { WORK_SECTIONS } from './sections';

/**
 * The Work page (PR B0 shell): where the signed-in person's page is listed at a business. Each
 * lane's card is drawn per membership from the registry once `GET /v1/me/work` answers (B3);
 * until then each workplace is named from the business roles.
 */
export function WorkView() {
  const [roles, setRoles] = useState<MyBusinessRoles | null | undefined>(
    undefined,
  );
  const [memberships, setMemberships] = useState<MyMembership[] | null>(null);

  useEffect(() => {
    void loadBusinessRoles().then(setRoles);
    void apiFetch<MyMembership[]>('/v1/me/work').then((result) =>
      setMemberships(
        result.ok && Array.isArray(result.data) ? result.data : null,
      ),
    );
  }, []);

  if (roles === undefined)
    return (
      <div className="dashboard-section work-page">
        <Skeleton label="Loading where you work" />
      </div>
    );
  const works = roles?.works ?? [];
  return (
    <div className="dashboard-section work-page">
      <header className="work-page__head">
        <h1>Work</h1>
      </header>
      {works.length === 0 ? (
        <EmptySlip title="You don’t work anywhere on TipMe yet.">
          <p>When a business invites you, it shows here.</p>
        </EmptySlip>
      ) : memberships && memberships.length > 0 ? (
        memberships.map((membership) => (
          <section
            key={membership.memberId}
            aria-label={`${membership.business.name} · ${membership.location.name}`}
            className="work-membership"
          >
            <h2>
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
      ) : (
        <ul className="work-page__places">
          {works.map((work) => (
            <li key={work.memberId}>
              {work.businessName} · {work.locationName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
