import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { ResolvedCover } from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { TippingOpensSoon } from '@/components/tipping-opens-soon';
import { TipsNotReady } from '@/components/profile/tips-not-ready';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ProfileViewTracker } from '@/components/profile-view-tracker';
import { ReportPage } from '@/components/report-page';
import { movedProfilePath } from '@/lib/handle-redirect';
import { previewMetadata } from '@/lib/metadata';
import { getPaymentMode } from '@/lib/payment-mode-api';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { getPublicProfile } from '@/lib/profiles-api';

type Props = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const profile = await getPublicProfile((await params).handle);
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
  const profile = await getPublicProfile((await params).handle);
  if (!profile) notFound();
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
            {!copy.payable ? (
              <TippingOpensSoon handle={profile.handle} />
            ) : profile.acceptingTips === false ? (
              <TipsNotReady recipient={firstName} />
            ) : (
              <AppreciationForm
                surface="profile"
                paymentMode={mode}
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
          <ReportPage handle={profile.handle} />
          {copy.previewPages && (
            <Link href="/about-preview">Learn about this preview</Link>
          )}
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
