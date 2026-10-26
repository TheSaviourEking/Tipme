import Image from 'next/image';
import type { ReactNode } from 'react';
import type { PublicProfile } from '@tipme/contracts';
import { Surface } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** The portrait the page is composed around; a framed monogram when none is shared. */
export function RecipientPortrait({ profile }: { profile: PublicProfile }) {
  return (
    <figure className="profile-portrait" data-profile-portrait>
      {profile.avatarPath ? (
        <AvatarImage
          className="profile-portrait__media"
          src={profile.avatarPath}
          name={profile.displayName}
          width={960}
          height={1200}
          sizes="(max-width: 800px) calc(100vw - 2.5rem), 34vw"
          priority
        />
      ) : (
        <span
          className="profile-portrait__media avatar--initials"
          role="img"
          aria-label={`Portrait unavailable for ${profile.displayName}`}
        >
          {initialsFor(profile.displayName)}
        </span>
      )}
    </figure>
  );
}

export function RecipientIdentity({
  profile,
  children,
}: {
  profile: PublicProfile;
  children?: ReactNode;
}) {
  return (
    <Surface className="profile-identity" material="raised" data-profile-card>
      <div className="profile-identity__head">
        {/* Decorative repeat of the portrait: the figure above carries the description. */}
        {profile.avatarPath && (
          <Image
            className="profile-identity__avatar"
            src={profile.avatarPath}
            alt=""
            width={96}
            height={96}
            sizes="48px"
          />
        )}
        <div>
          <h1 id="profile-name">{profile.displayName}</h1>
          <p className="profile-identity__handle">@{profile.handle}</p>
        </div>
      </div>
      {profile.role && <p className="profile-role">{profile.role}</p>}
      {profile.bio && <p className="profile-bio">{profile.bio}</p>}
      {children}
    </Surface>
  );
}
