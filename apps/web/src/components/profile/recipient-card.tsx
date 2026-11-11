import type { ReactNode } from 'react';
import {
  SOCIAL_PLATFORMS,
  linkHandle,
  linksFromLegacy,
  type PublicProfile,
  type SocialLink,
} from '@tipme/contracts';
import { ProBadge } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { LinkBadge } from './link-badge';
import { ShareProfile } from '@/components/share-profile';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const ICONS = {
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

function ContactLink({
  icon,
  href,
  children,
}: {
  icon: keyof typeof ICONS;
  href: string;
  children: ReactNode;
}) {
  return (
    <li>
      <a href={href}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          {ICONS[icon]}
        </svg>
        {children}
      </a>
    </li>
  );
}

const NEW_TAB = ' (opens in a new tab)';
const external = {
  // Links people typed: `ugc` tells search engines so, as well as not following them.
  rel: 'noopener noreferrer nofollow ugc',
  target: '_blank',
} as const;

/**
 * Where else to find this person (SocialLinks board): a Pro page's featured link as a full-width
 * key, then a row of links, each showing the handle read from it so supporters can check it's
 * really them. They open in a new tab and never sit between the amount and the Tip button.
 */
export function ProfileLinks({
  links,
  firstName,
}: {
  links: SocialLink[];
  firstName: string;
}) {
  if (links.length === 0) return null;
  const featured = links.find((link) => link.featured);
  const rest = links.filter((link) => link !== featured);
  return (
    <div className="profile-links">
      {featured && (
        <a
          className="profile-links__featured"
          href={featured.url}
          {...external}
        >
          <LinkBadge platform={featured.platform} />
          <span className="profile-links__words">
            {SOCIAL_PLATFORMS[featured.platform].featured}
          </span>{' '}
          <span className="profile-links__handle">
            {linkHandle(featured) ?? SOCIAL_PLATFORMS[featured.platform].label}
          </span>
          <span className="sr-only">{NEW_TAB}</span>
        </a>
      )}
      {rest.length > 0 && (
        <ul
          className="profile-links__row"
          aria-label={`Find ${firstName} elsewhere`}
        >
          {rest.map((link) => {
            const { label } = SOCIAL_PLATFORMS[link.platform];
            const handle = linkHandle(link);
            return (
              <li key={link.url}>
                <a href={link.url} {...external}>
                  <LinkBadge platform={link.platform} small />
                  {handle ? (
                    <>
                      <span className="sr-only">{label}: </span>
                      {handle}
                    </>
                  ) : (
                    label
                  )}
                  <span className="sr-only">{NEW_TAB}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Contact({
  profile,
  firstName,
}: {
  profile: PublicProfile;
  firstName: string;
}) {
  if (!profile.phone && !profile.email) return null;
  return (
    <ul className="profile-contact" aria-label={`Contact ${firstName}`}>
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
          <p className="profile-identity__handle">
            @{profile.handle}
            {profile.plan === 'pro' && (
              <ProBadge explain className="profile-identity__pro" />
            )}
          </p>
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
      <ProfileLinks
        links={profile.links ?? linksFromLegacy(profile.socials)}
        firstName={firstName}
      />
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
