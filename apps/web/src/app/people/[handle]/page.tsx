import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { PublicProfile } from '@tipme/contracts';
import { Container } from '@tipme/ui';
import { AppreciationForm } from '@/components/appreciation-form';
import { TipsNotReady } from '@/components/profile/tips-not-ready';
import {
  RecipientIdentity,
  RecipientPortrait,
} from '@/components/profile/recipient-card';
import { ProfileViewTracker } from '@/components/profile-view-tracker';
import { ReportPage } from '@/components/report-page';
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
        `${profile.role ?? 'A TipMe recipient'}. Test mode.`,
        `/@${profile.handle}`,
      )
    : { title: 'Page unavailable', robots: { index: false, follow: false } };
}

const socialNames = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X (Twitter)',
} as const;

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
        <nav className="profile-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Meet {firstName}</span>
        </nav>
        {/* Portrait-led composition: the identity card and tipping panel overlap the portrait. */}
        <div className="profile-stage">
          <div className="profile-scene">
            <div className="profile-headline">
              <p className="profile-headline__title">Support Great People</p>
              <p className="profile-headline__lede">
                A simpler, more thoughtful way to send appreciation.
              </p>
            </div>
            <RecipientPortrait profile={profile} />
            <section
              className="profile-identity-slot"
              aria-labelledby="profile-name"
            >
              <RecipientIdentity profile={profile} />
            </section>
          </div>
          <aside
            className="profile-composer tip-instrument"
            aria-label={`Tip ${firstName}`}
            data-tip-panel
          >
            {profile.acceptingTips === false ? (
              <TipsNotReady recipient={firstName} />
            ) : (
              <AppreciationForm
                recipient={firstName}
                handle={profile.handle}
                collapseExtras
                {...(profile.tipAmounts
                  ? { tipAmounts: profile.tipAmounts }
                  : {})}
                {...(profile.celebration
                  ? { celebration: profile.celebration }
                  : {})}
              />
            )}
          </aside>
        </div>
        <section className="profile-more" aria-label={`More from ${firstName}`}>
          {(profile.craft ?? profile.note) && (
            <div className="profile-more__words">
              {profile.craft && (
                <p className="profile-more__craft">{profile.craft}</p>
              )}
              {profile.note && (
                <blockquote className="profile-note">{profile.note}</blockquote>
              )}
            </div>
          )}
          <div className="profile-more__links">
            <Contact profile={profile} />
            <ShareProfile handle={profile.handle} />
          </div>
          <div className="profile-safety">
            <p>
              No account needed. TipMe is in test mode: no real money moves yet.
            </p>
            <Link href="/about-preview">Learn about this preview</Link>
            <ReportPage handle={profile.handle} />
          </div>
        </section>
      </Container>
    </main>
  );
}
