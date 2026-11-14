'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type {
  BusinessDetail,
  BusinessStatus,
  MyBusinessRoles,
} from '@tipme/contracts';
import { EmptySlip, Skeleton } from '@tipme/ui';
import { BusinessLogoTile } from '@/components/business/business-logo-tile';
import { useAccount } from '@/components/account/account-context';
import { OwnPageCard } from '@/components/business/own-page-card';
import { VerifiedMoment } from '@/components/business/verified-moment';
import { WaitingSteps } from '@/components/business/waiting-steps';
import { useManagedLogo } from '@/lib/business/logo';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { apiFetch } from '@/lib/session-client';
import { BUSINESS_SECTIONS } from './sections';
import { useBusinessRevision } from '@/lib/business/use-business-live';

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
      // `?business=` (after creating one) chooses it, when this person manages it.
      const asked = new URLSearchParams(window.location.search).get('business');
      const manages = loaded?.manages ?? [];
      setChosen(
        manages.find((entry) => entry.businessId === asked)?.businessId ??
          manages[0]?.businessId ??
          null,
      );
    });
  }, []);

  const revision = useBusinessRevision();
  useEffect(() => {
    if (!chosen) return;
    void apiFetch<BusinessDetail>(`/v1/me/businesses/${chosen}`).then(
      (result) => {
        // A failed re-read keeps what is shown; only the first read shows the failure.
        if (!result.ok && revision > 0) return;
        setLoaded({ id: chosen, detail: result.ok ? result.data : null });
      },
    );
  }, [chosen, revision]);
  const detail = loaded?.id === chosen ? loaded.detail : null;
  const logo = useManagedLogo(detail);
  // Business sign-up (Phase D): what happens next while waiting, the verified moment, and a page
  // of their own for a login with none. Off: today's page exactly.
  const { account, flags, accountOnly } = useAccount();
  const signup = flags?.businessSignup === true;

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
        <div className="business-page__brand">
          {current && (
            <BusinessLogoTile
              name={detail?.name ?? current.name}
              src={logo}
              className="business-page__logo"
            />
          )}
          <h1>{detail?.name ?? current?.name ?? 'Business'}</h1>
        </div>
        {current && (
          <p className="tm-hint" data-testid="business-status">
            {STATUS_WORDS[detail?.status ?? current.status]}
          </p>
        )}
        {current && (detail?.status ?? current.status) !== 'verified' && (
          // Anyone may open a location page, the owner included. Until TipMe verifies the business
          // (or while it is paused) it reads only the "isn't taking tips" state (M11): say so.
          <p className="tm-hint" data-testid="business-preview-note">
            {(detail?.status ?? current.status) === 'suspended'
              ? `While TipMe has paused ${current.name}, `
              : `Until TipMe verifies ${current.name}, `}
            your location pages show “This business isn’t taking tips on TipMe
            right now.” to everyone, you included.
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
        <EmptySlip
          title="You don’t manage a business on TipMe."
          action={
            roles ? (
              <Link href="/dashboard/business/apply">Create your business</Link>
            ) : undefined
          }
        >
          <p>When you do, its locations, team and codes show here.</p>
        </EmptySlip>
      ) : detail ? (
        <>
          {signup && detail.you.celebrate && (
            <VerifiedMoment business={detail} />
          )}
          {signup && detail.status === 'pending' && (
            <WaitingSteps business={detail} email={account?.email ?? null} />
          )}
          {signup && accountOnly && detail.you.role === 'owner' && (
            <OwnPageCard businessName={detail.name} />
          )}
          {BUSINESS_SECTIONS.filter(
            (section) =>
              section.needs !== 'owner' || detail.you.role === 'owner',
          ).map(({ id, title, Card }) => (
            <section
              key={id}
              id={id}
              aria-labelledby={`${id}-title`}
              className="business-section"
            >
              <h2 id={`${id}-title`}>{title}</h2>
              <Card
                business={detail}
                onChange={(next) => setLoaded({ id: next.id, detail: next })}
              />
            </section>
          ))}
        </>
      ) : (
        <EmptySlip title="Nothing to set up here yet.">
          <p>Your business’s locations, team and codes will show here.</p>
        </EmptySlip>
      )}
    </div>
  );
}
