import type { ReactNode } from 'react';
import type { PublicProfile } from '@tipme/contracts';
import { Surface } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { ProfileSpark } from './profile-symbols';

export function RecipientCard({
  profile,
  children,
}: {
  profile: PublicProfile;
  children?: ReactNode;
}) {
  return (
    <article className="recipient-card" data-profile-card>
      <div className="recipient-card__visual">
        {profile.avatarPath ? (
          <AvatarImage
            className="recipient-card__portrait"
            src={profile.avatarPath}
            name={profile.displayName}
            width={960}
            height={1200}
            sizes="(max-width: 800px) calc(100vw - 2rem), 50vw"
            priority
          />
        ) : (
          <span
            className="recipient-card__portrait avatar--initials"
            aria-label={`Portrait unavailable for ${profile.displayName}`}
          >
            {profile.displayName
              .split(/\s+/)
              .map((part) => part[0] ?? '')
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
        )}
        <ProfileSpark />
        {profile.craft && (
          <p className="recipient-card__craft">{profile.craft}</p>
        )}
      </div>
      <Surface className="recipient-card__sheet" material="raised">
        <p className="eyebrow">@{profile.handle}</p>
        <h1 id="profile-name">{profile.displayName}</h1>
        {profile.role && <p className="profile-role">{profile.role}</p>}
        {profile.bio && <p className="profile-bio">{profile.bio}</p>}
        {profile.note && (
          <blockquote className="profile-note">{profile.note}</blockquote>
        )}
        {children}
      </Surface>
    </article>
  );
}
