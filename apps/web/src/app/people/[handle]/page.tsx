import Link from 'next/link';
import { permanentRedirect } from 'next/navigation';
import type { ResolvedCover } from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { PilotNotice } from '@/components/pilot-notice';
import { TippingOpensSoon } from '@/components/tipping-opens-soon';
import { TipsNotReady } from '@/components/profile/tips-not-ready';
import { PageRetry } from '@/components/profile/page-retry';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ProfileViewTracker } from '@/components/profile-view-tracker';
import { ReportPage } from '@/components/report-page';
import { movedProfilePath } from '@/lib/handle-redirect';
import { previewMetadata } from '@/lib/metadata';
import { getPaymentMode } from '@/lib/payment-mode-api';
import { profileTippingClosed } from '@/lib/payment-mode';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { loadPublicProfile } from '@/lib/profiles-api';
import ProfileUnavailable from './not-found';

// Wait for the cached page rather than stream a silhouette: the name and photo are in the first
// paint and work without scripts. The status stays 200 for an unknown or moved handle, because
// Partial Prerendering sends the root shell before this page runs.
export const instant = false;

type Props = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const profile = await loadPublicProfile((await params).handle);
  // Says nothing about the page: not "unavailable", and no robots rule of its own.
  if (profile === 'unreachable') return { title: 'Let’s try that again' };
  const copy = paymentModeCopy(await getPaymentMode());
  return profile && !('movedTo' in profile)
    ? previewMetadata(
        `${profile.displayName} on TipMe`,
        `${profile.role ?? 'A TipMe recipient'}.${copy.profileMetaSuffix}`,
        `/@${profile.handle}`,
      )
    : { title: 'Page unavailable', robots: { index: false, follow: false } };
}

// An API older than the covers sends none: the same quiet look a cover falls back to.
const NO_COVER: ResolvedCover = {
  kind: 'design',
  design: 'scattered',
  colour: 'neutral',
};

export default async function ProfilePage({ params, searchParams }: Props) {
  const { handle } = await params;
  const profile = await loadPublicProfile(handle);
  if (profile === 'unreachable')
    return <PageRetry href={movedProfilePath(handle, await searchParams)} />;
  // Rendered, not thrown: the status is 200 either way here, and a thrown not-found leaves the
  // page blank without scripts.
  if (!profile) return <ProfileUnavailable />;
  // An old handle of a renamed page: 308 to the current one (printed QR codes keep working).
  if ('movedTo' in profile)
    permanentRedirect(movedProfilePath(profile.movedTo, await searchParams));
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  const mode = await getPaymentMode();
  const copy = paymentModeCopy(mode);
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <ProfileViewTracker handle={profile.handle} />
      <div className="profile-sheet">
        <ProfileCover cover={profile.cover ?? NO_COVER} priority />
        <div className="profile-columns">
          <RecipientIdentity profile={profile} firstName={firstName} />
          <aside
            className="profile-composer tip-instrument"
            aria-label={`Tip ${firstName}`}
            data-tip-panel
          >
            {/* Closed checkout outranks the owner's own setup: nobody can tip yet. */}
            {!copy.payable || profileTippingClosed(mode, profile) ? (
              <TippingOpensSoon handle={profile.handle} />
            ) : profile.acceptingTips === false ? (
              <TipsNotReady recipient={firstName} />
            ) : (
              <AppreciationForm
                surface="profile"
                paymentMode={mode}
                pilotNotice={<PilotNotice />}
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
        <footer className="profile-foot">
          <div className="profile-foot__quiet">
            <ReportPage handle={profile.handle} />
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
            {copy.previewPages && (
              <Link href="/about-preview">Learn about this preview</Link>
            )}
          </div>
          {profile.plan !== 'pro' && (
            <Link className="profile-foot__own" href="/sign-up">
              Get your own TipMe page
            </Link>
          )}
        </footer>
      </div>
    </main>
  );
}
