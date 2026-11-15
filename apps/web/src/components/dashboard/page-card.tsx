'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { MyProfile } from '@tipme/contracts';
import { ProBadge, Surface } from '@tipme/ui';
import { dateOf } from '@/lib/lagos-time';
import { PLAN_HREF, readMyPro } from '@/lib/pro-buy';
import { AvatarImage } from '@/components/avatar';
import { hasAvatar } from '@/lib/avatar-source';

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** When a paid Pro month ends, for the card's plan line; null for Free, staff Pro or no answer. */
function usePaidUntil(pro: boolean): string | null {
  const [until, setUntil] = useState<string | null>(null);
  useEffect(() => {
    if (!pro) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the line goes when Pro does
      setUntil(null);
      return;
    }
    let live = true;
    void readMyPro().then((result) => {
      if (!live) return;
      const current = result.ok ? result.data.current : null;
      const next = result.ok ? result.data.next : null;
      setUntil((next ?? current)?.endsAt ?? null);
    });
    return () => {
      live = false;
    };
  }, [pro]);
  return until;
}

/** The recipient's own page as an object they can hold: who it shows, and whether it's online. */
export function PageCard({ profile }: { profile: MyProfile }) {
  const live = profile.pageState === 'live';
  const pro = profile.plan === 'pro';
  const paidUntil = usePaidUntil(pro);
  return (
    <Surface material="raised" className="page-card">
      <div className="page-card__head">
        <span className="page-card__monogram" aria-hidden="true">
          {/* Their photo when they have one; the initials only when not. */}
          {hasAvatar(profile.avatarPath) ? (
            <AvatarImage
              src={profile.avatarPath}
              name={profile.displayName}
              width={52}
              height={52}
              sizes="52px"
            />
          ) : (
            initialsFor(profile.displayName)
          )}
        </span>
        <div>
          <p className="page-card__name">
            {profile.displayName}
            {pro && <ProBadge />}
          </p>
          <p className="page-card__handle">@{profile.handle}</p>
        </div>
      </div>
      {profile.role && <p className="page-card__role">{profile.role}</p>}
      <p
        className={`page-card__state page-card__state--${live ? 'live' : 'off'}`}
      >
        {live ? 'Your page is live' : 'Your page isn’t online yet'}
      </p>
      {pro && (
        <p className="page-card__plan">
          {paidUntil ? `Pro, paid until ${dateOf(paidUntil)}` : 'On TipMe Pro'}{' '}
          <Link href={PLAN_HREF}>Manage</Link>
        </p>
      )}
      {/* A gentle way back into setup while the page is offline; never a nag. */}
      {!live && !profile.suspended && (
        <Link className="page-card__finish" href="/dashboard/welcome">
          Finish setting up
        </Link>
      )}
      <div className="page-card__links">
        {live && <Link href={`/@${profile.handle}`}>See my page</Link>}
        <Link href="/dashboard/settings">Edit my page</Link>
      </div>
    </Surface>
  );
}
