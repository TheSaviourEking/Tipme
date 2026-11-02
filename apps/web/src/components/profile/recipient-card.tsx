import type { ReactNode } from 'react';
import type { PublicProfile } from '@tipme/contracts';
import { AvatarImage } from '@/components/avatar';
import { ShareProfile } from '@/components/share-profile';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const ICONS = {
  x: (
    <path
      fill="currentColor"
      d="M18.2 2.5h3.3l-7.2 8.2 8.5 10.8h-6.7l-5.2-6.5-6 6.5H1.6l7.7-8.8L1.2 2.5H8l4.7 6 5.5-6Zm-1.2 17h1.8L7.1 4.4h-2L17 19.5Z"
    />
  ),
  instagram: (
    <g {...stroke}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
    </g>
  ),
  facebook: (
    <path
      fill="currentColor"
      d="M14 8.5V6.8c0-.8.5-1 1-1h2V2.5h-2.9C11.2 2.5 10 4.5 10 6.5v2H7.5V12H10v9.5h4V12h2.7l.5-3.5H14Z"
    />
  ),
  phone: (
    <path
      {...stroke}
      d="M21 16.5v3a1.5 1.5 0 0 1-1.6 1.5A17.5 17.5 0 0 1 3 4.6 1.5 1.5 0 0 1 4.5 3h3a1.5 1.5 0 0 1 1.5 1.3c.1.9.3 1.8.6 2.6a1.5 1.5 0 0 1-.3 1.6L8 9.8a14 14 0 0 0 6.2 6.2l1.3-1.3a1.5 1.5 0 0 1 1.6-.3c.8.3 1.7.5 2.6.6a1.5 1.5 0 0 1 1.3 1.5Z"
    />
  ),
  email: (
    <g {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </g>
  ),
};

const SOCIAL_NAMES = {
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
} as const;

function ContactLink({
  icon,
  href,
  external = false,
  children,
}: {
  icon: keyof typeof ICONS;
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        {...(external
          ? { rel: 'noopener noreferrer nofollow', target: '_blank' }
          : {})}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          {ICONS[icon]}
        </svg>
        {children}
      </a>
    </li>
  );
}

function Contact({
  profile,
  firstName,
}: {
  profile: PublicProfile;
  firstName: string;
}) {
  const socials = Object.entries(profile.socials ?? {}) as [
    keyof typeof SOCIAL_NAMES,
    string,
  ][];
  if (socials.length === 0 && !profile.phone && !profile.email) return null;
  return (
    <ul className="profile-contact" aria-label={`Find ${firstName} elsewhere`}>
      {socials.map(([kind, url]) => (
        <ContactLink key={kind} icon={kind} href={url} external>
          {SOCIAL_NAMES[kind]}
        </ContactLink>
      ))}
      {profile.phone && (
        <ContactLink icon="phone" href={`tel:${profile.phone}`}>
          {profile.phone}
        </ContactLink>
      )}
      {profile.email && (
        <ContactLink icon="email" href={`mailto:${profile.email}`}>
          {profile.email}
        </ContactLink>
      )}
    </ul>
  );
}

/** Who this page is for: photo over the cover's edge, name, handle, role, bio, links, share. */
export function RecipientIdentity({
  profile,
  firstName,
  celebrationLabel = null,
}: {
  profile: PublicProfile;
  firstName: string;
  /** A moment this page shared and supporters can add a tip to, such as "10th tip". */
  celebrationLabel?: string | null;
}) {
  return (
    <section
      className="profile-identity"
      aria-labelledby="profile-name"
      data-profile-card
    >
      <div className="profile-identity__head">
        {/* No photo (or one that fails to load): initials in the same circle. */}
        <AvatarImage
          className="profile-photo"
          src={profile.avatarPath ?? ''}
          name={profile.displayName}
          width={288}
          height={288}
          sizes="(max-width: 860px) 104px, 144px"
          priority
        />
        <div className="profile-identity__name">
          <h1
            id="profile-name"
            {...(profile.displayName.length > 24
              ? { className: 'profile-name--long' }
              : {})}
          >
            {profile.displayName}
          </h1>
          <p className="profile-identity__handle">@{profile.handle}</p>
        </div>
        <ShareProfile handle={profile.handle} />
      </div>
      {profile.role && <p className="profile-role">{profile.role}</p>}
      {profile.bio && <p className="profile-bio">{profile.bio}</p>}
      {celebrationLabel && (
        <p className="profile-celebration">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 21s-7.5-4.6-9.6-9.3C1 8.4 3 5 6.4 5c2.2 0 4 1.2 5.6 3.4C13.6 6.2 15.4 5 17.6 5 21 5 23 8.4 21.6 11.7 19.5 16.4 12 21 12 21z"
            />
          </svg>
          <span>
            Celebrating {firstName}’s {celebrationLabel}
          </span>
        </p>
      )}
      <Contact profile={profile} firstName={firstName} />
      {(profile.craft ?? profile.note) && (
        <div className="profile-words">
          {profile.craft && (
            <p className="profile-words__craft">{profile.craft}</p>
          )}
          {profile.note && (
            <p className="profile-words__note">{profile.note}</p>
          )}
        </div>
      )}
    </section>
  );
}
