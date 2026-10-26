'use client';
import Link from 'next/link';
import type { MyProfile } from '@tipme/contracts';
import { Surface } from '@tipme/ui';

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** The recipient's own page as an object they can hold: who it shows, and whether it's online. */
export function PageCard({ profile }: { profile: MyProfile }) {
  const live = profile.pageState === 'live';
  return (
    <Surface material="raised" className="page-card">
      <div className="page-card__head">
        <span className="page-card__monogram" aria-hidden="true">
          {initialsFor(profile.displayName)}
        </span>
        <div>
          <p className="page-card__name">{profile.displayName}</p>
          <p className="page-card__handle">@{profile.handle}</p>
        </div>
      </div>
      {profile.role && <p className="page-card__role">{profile.role}</p>}
      <p
        className={`page-card__state page-card__state--${live ? 'live' : 'off'}`}
      >
        {live ? 'Your page is live' : 'Your page isn’t online yet'}
      </p>
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
