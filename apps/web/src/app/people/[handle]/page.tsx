import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { PublicProfile } from '@tipme/contracts';
import { Badge, Container } from '@tipme/ui';
import { AppreciationForm } from '@/components/appreciation-form';
import { Avatar } from '@/components/avatar';
import { ProfileViewTracker } from '@/components/profile-view-tracker';
import { ShareProfile } from '@/components/share-profile';
import { movedProfilePath } from '@/lib/handle-redirect';
import { previewMetadata } from '@/lib/metadata';
import { getPublicProfile } from '@/lib/profiles-api';

type Props = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const profile = await getPublicProfile((await params).handle);
  return profile && !('movedTo' in profile)
    ? previewMetadata(
        `${profile.displayName} on TipMe`,
        `${profile.role ?? 'A TipMe recipient'}. Pretend payments only.`,
        `/@${profile.handle}`,
      )
    : { title: 'Page unavailable', robots: { index: false, follow: false } };
}

const socialNames = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X (Twitter)',
} as const;

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar avatar--initials" aria-hidden="true">
      {letters}
    </span>
  );
}

function Contact({ profile }: { profile: PublicProfile }) {
  const socials = Object.entries(profile.socials ?? {}) as [
    keyof typeof socialNames,
    string,
  ][];
  if (socials.length === 0 && !profile.phone && !profile.email) return null;
  return (
    <ul className="profile-contact" aria-label="Find me elsewhere">
      {socials.map(([kind, url]) => (
        <li key={kind}>
          <a href={url} rel="noopener noreferrer nofollow" target="_blank">
            {socialNames[kind]}
          </a>
        </li>
      ))}
      {profile.phone && (
        <li>
          <a href={`tel:${profile.phone}`}>{profile.phone}</a>
        </li>
      )}
      {profile.email && (
        <li>
          <a href={`mailto:${profile.email}`}>{profile.email}</a>
        </li>
      )}
    </ul>
  );
}

export default async function ProfilePage({ params, searchParams }: Props) {
  const profile = await getPublicProfile((await params).handle);
  if (!profile) notFound();
  // An old handle of a renamed page: 308 to the current one (printed QR codes keep working).
  if ('movedTo' in profile)
    permanentRedirect(movedProfilePath(profile.movedTo, await searchParams));
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <ProfileViewTracker handle={profile.handle} />
      <Container>
        <div className="profile-breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span>Meet {firstName}</span>
          <Badge>Pretend payments</Badge>
        </div>
        <div className="profile-grid">
          <section className="profile-story" aria-labelledby="profile-name">
            {profile.craft && (
              <div className="profile-cover">
                <span aria-hidden="true">✳</span>
                <p>{profile.craft}</p>
              </div>
            )}
            {profile.avatarPath ? (
              <Avatar
                src={profile.avatarPath}
                name={profile.displayName}
                size={120}
              />
            ) : (
              <Initials name={profile.displayName} />
            )}
            <div className="profile-identity">
              <p className="eyebrow">@{profile.handle}</p>
              <h1 id="profile-name">{profile.displayName}</h1>
              {profile.role && <p className="profile-role">{profile.role}</p>}
            </div>
            {profile.bio && <p className="profile-bio">{profile.bio}</p>}
            {profile.note && (
              <blockquote className="profile-note">
                <span aria-hidden="true">“</span>
                {profile.note}
              </blockquote>
            )}
            <Contact profile={profile} />
            <ShareProfile handle={profile.handle} />
            <p className="profile-fineprint">
              Payments on TipMe are pretend during the preview.
              <br />
              No real money moves.
            </p>
          </section>
          <aside className="profile-composer" aria-label={`Tip ${firstName}`}>
            <AppreciationForm
              recipient={firstName}
              handle={profile.handle}
              {...(profile.tipAmounts
                ? { tipAmounts: profile.tipAmounts }
                : {})}
              {...(profile.celebration
                ? { celebration: profile.celebration }
                : {})}
            />
            <div className="profile-safety">
              <span aria-hidden="true">◇</span>
              <p>
                No account. Pretend payments only: no real money moves.
                <br />
                <Link href="/about-preview">Learn about this preview</Link>
              </p>
            </div>
          </aside>
        </div>
      </Container>
    </main>
  );
}
