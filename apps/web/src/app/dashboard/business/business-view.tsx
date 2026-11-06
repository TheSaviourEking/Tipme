'use client';
import { useEffect, useId, useState } from 'react';
import type {
  BusinessDetail,
  BusinessStatus,
  MyBusinessRoles,
} from '@tipme/contracts';
import { EmptySlip, Skeleton } from '@tipme/ui';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { apiFetch } from '@/lib/session-client';
import { BUSINESS_SECTIONS } from './sections';

const STATUS_WORDS: Record<BusinessStatus, string> = {
  pending: 'Waiting to be verified',
  verified: 'Verified business',
  suspended: 'Paused by TipMe',
};

/**
 * The Business page (PR B0 shell). It lists what the signed-in person manages, with a picker when
 * there are several, and draws each lane's section from the registry once the business's detail
 * loads (B1). Until then it shows the business's name and that nothing is set up here yet.
 */
export function BusinessView() {
  const pickerId = useId();
  const [roles, setRoles] = useState<MyBusinessRoles | null | undefined>(
    undefined,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  // Kept with the business it belongs to, so switching never shows the last one's detail.
  const [loaded, setLoaded] = useState<{
    id: string;
    detail: BusinessDetail | null;
  } | null>(null);

  useEffect(() => {
    void loadBusinessRoles().then((loaded) => {
      setRoles(loaded);
      setChosen(loaded?.manages[0]?.businessId ?? null);
    });
  }, []);

  useEffect(() => {
    if (!chosen) return;
    void apiFetch<BusinessDetail>(`/v1/me/businesses/${chosen}`).then(
      (result) =>
        setLoaded({ id: chosen, detail: result.ok ? result.data : null }),
    );
  }, [chosen]);
  const detail = loaded?.id === chosen ? loaded.detail : null;

  if (roles === undefined)
    return (
      <div className="dashboard-section business-page">
        <Skeleton label="Loading your business" />
      </div>
    );
  const manages = roles?.manages ?? [];
  const current = manages.find((entry) => entry.businessId === chosen);
  return (
    <div className="dashboard-section business-page">
      <header className="business-page__head">
        <h1>{current ? current.name : 'Business'}</h1>
        {current && (
          <p className="tm-hint" data-testid="business-status">
            {STATUS_WORDS[current.status]}
          </p>
        )}
      </header>
      {manages.length > 1 && (
        <div className="tm-field business-page__picker">
          <label htmlFor={pickerId}>Business</label>
          <select
            id={pickerId}
            className="tm-input"
            value={chosen ?? ''}
            onChange={(event) => setChosen(event.target.value)}
          >
            {manages.map((entry) => (
              <option key={entry.businessId} value={entry.businessId}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {!current ? (
        <EmptySlip title="You don’t manage a business on TipMe.">
          <p>When you do, its locations, team and codes show here.</p>
        </EmptySlip>
      ) : detail ? (
        BUSINESS_SECTIONS.filter(
          (section) => section.needs !== 'owner' || detail.you.role === 'owner',
        ).map(({ id, title, Card }) => (
          <section
            key={id}
            id={id}
            aria-labelledby={`${id}-title`}
            className="business-section"
          >
            <h2 id={`${id}-title`}>{title}</h2>
            <Card business={detail} />
          </section>
        ))
      ) : (
        <EmptySlip title="Nothing to set up here yet.">
          <p>Your business’s locations, team and codes will show here.</p>
        </EmptySlip>
      )}
    </div>
  );
}
