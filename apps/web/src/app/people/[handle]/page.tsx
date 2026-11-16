import Link from 'next/link';
import { permanentRedirect } from 'next/navigation';
import { resolveCover, type PublicProfile } from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { PilotNotice } from '@/components/pilot-notice';
import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeShown,
} from '@/lib/pilot';
import { TippingOpensSoon } from '@/components/tipping-opens-soon';
import { TipsNotReady } from '@/components/profile/tips-not-ready';
import { PageRetry } from '@/components/profile/page-retry';
import { ProfileCover } from '@/components/profile/cover';
import { CoverFreeze } from '@/components/profile/cover-freeze';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ProfileViewTracker } from '@/components/profile-view-tracker';
import { ReportPage } from '@/components/report-page';
import { movedProfilePath } from '@/lib/handle-redirect';
import { previewMetadata } from '@/lib/metadata';
import { getDisplaySettings } from '@/lib/display-settings-api';
import { getPaymentMode } from '@/lib/payment-mode-api';
import { profileTippingClosed, type PaymentMode } from '@/lib/payment-mode';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { CampaignTop } from '@/components/profile/campaign-top';
import { getPublicCampaignPage, loadPublicProfile } from '@/lib/profiles-api';
import { API_ORIGIN as BROWSER_API_ORIGIN } from '@/lib/avatar-source';
import { identityFor, studioFor } from '@/lib/public-studio';
import { studioLabOpen } from '@/app/dev/studio-lab/lab-gate';
import ProfileUnavailable from './not-found';

// Wait for the cached page rather than stream a silhouette: the name and photo are in the first
// paint and work without scripts. The status stays 200 for an unknown or moved handle, because
// Partial Prerendering sends the root shell before this page runs.
export const instant = false;

type Props = {
  // `campaign` only on /@handle/<ending> (the [campaign] route re-exports this page).
  params: Promise<{ handle: string; campaign?: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { handle, campaign } = await params;
  const profile = await loadPublicProfile(handle);
  // Says nothing about the page: not "unavailable", and no robots rule of its own.
  if (profile === 'unreachable') return { title: 'Let’s try that again' };
  const copy = paymentModeCopy(await getPaymentMode());
  if (!profile || 'movedTo' in profile)
    return {
      title: 'Page unavailable',
      robots: { index: false, follow: false },
    };
  const base = previewMetadata(
    `${profile.displayName} on TipMe`,
    `${profile.role ?? 'A TipMe recipient'}.${copy.profileMetaSuffix}`,
    `/@${profile.handle}`,
    {
      url: `/people/${profile.handle}/share-card`,
      alt: `${profile.displayName} on TipMe`,
    },
  );
  // A campaign's own page (ruling 10): not indexed, links followed, canonical the main page.
  return campaign && (await getPublicCampaignPage(profile.handle, campaign))
    ? {
        ...base,
        robots: { index: false, follow: true },
        alternates: { canonical: `/@${profile.handle}` },
      }
    : base;
}

export default async function ProfilePage({ params, searchParams }: Props) {
  const { handle, campaign } = await params;
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
  const pilotShown = pilotNoticeShown(
    await getDisplaySettings(),
    process.env,
    mode,
  );
  // Closed checkout outranks the owner's own setup: nobody can tip yet.
  const opensSoon = !copy.payable || profileTippingClosed(mode, profile);
  const takesTips = !opensSoon && profile.acceptingTips !== false;
  // An API older than the covers sends none: work out the same automatic one here.
  const cover =
    profile.cover ??
    resolveCover({
      handle: profile.handle,
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    });
  // A campaign's own page (Pro): its top and cover change; the person and tip area never do.
  const campaignPage = campaign
    ? await getPublicCampaignPage(profile.handle, campaign)
    : null;
  const shownCover = campaignPage?.cover ?? cover;
  const coverView = (
    <>
      <ProfileCover cover={shownCover} priority animate />
      {shownCover.kind === 'animated' && shownCover.play !== 'still' ? (
        <CoverFreeze />
      ) : null}
    </>
  );
  // Page Studio (plan Task 8): a published design, sent by the API only while the `page_studio`
  // switch is on. Its renderer and stylesheet are loaded only here, so a standard page carries
  // neither. TipMe's cover, identity, tip block and footer go in unchanged.
  const studio = studioFor(profile, {
    apiOrigin: BROWSER_API_ORIGIN,
    labImages: studioLabOpen(),
    ...(campaign ? { campaign } : {}),
  });
  if (studio) {
    const { StudioPage } = await import('@/components/studio/studio-page');
    return (
      <main
        id="main"
        tabIndex={-1}
        className="profile-page profile-page--studio"
      >
        <ProfileViewTracker handle={profile.handle} />
        <StudioPage
          studio={studio}
          profile={profile}
          cover={coverView}
          identity={
            <RecipientIdentity
              profile={identityFor(profile, studio.document)}
              firstName={firstName}
              celebrationLabel={
                takesTips ? (profile.celebration?.label ?? null) : null
              }
            />
          }
          tipBlock={
            <TipBlock
              profile={profile}
              firstName={firstName}
              mode={mode}
              opensSoon={opensSoon}
              pilotShown={pilotShown}
            />
          }
          footer={
            <ProfileFoot
              profile={profile}
              firstName={firstName}
              campaign={false}
              previewPages={copy.previewPages}
            />
          }
        />
      </main>
    );
  }
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <ProfileViewTracker handle={profile.handle} />
      <div className="profile-sheet">
        {coverView}
        <div className="profile-columns">
          <RecipientIdentity
            profile={profile}
            firstName={firstName}
            // Only beside a form that can add to it.
            celebrationLabel={
              takesTips ? (profile.celebration?.label ?? null) : null
            }
            {...(campaignPage
              ? { after: <CampaignTop page={campaignPage} /> }
              : {})}
          />
          <aside
            className="profile-composer tip-instrument"
            aria-label={`Tip ${firstName}`}
            data-tip-panel
          >
            <TipBlock
              profile={profile}
              firstName={firstName}
              mode={mode}
              opensSoon={opensSoon}
              pilotShown={pilotShown}
            />
          </aside>
        </div>
        <ProfileFoot
          profile={profile}
          firstName={firstName}
          campaign={Boolean(campaignPage)}
          previewPages={copy.previewPages}
        />
      </div>
    </main>
  );
}

/** TipMe's tip block: the same on the standard page and beside a Studio design (locked). */
function TipBlock({
  profile,
  firstName,
  mode,
  opensSoon,
  pilotShown,
}: {
  profile: PublicProfile;
  firstName: string;
  mode: PaymentMode;
  opensSoon: boolean;
  pilotShown: boolean;
}) {
  return (
    <>
      {opensSoon ? (
        <TippingOpensSoon handle={profile.handle} name={firstName} />
      ) : profile.acceptingTips === false ? (
        <TipsNotReady recipient={firstName} />
      ) : (
        <AppreciationForm
          surface="profile"
          paymentMode={mode}
          {...(pilotShown
            ? {
                pilotNotice: <PilotNotice />,
                barNotice: (
                  <>
                    {PILOT_NOTICE_TEXT}{' '}
                    <a href={`mailto:${PILOT_NOTICE_SUPPORT_EMAIL}`}>
                      {PILOT_NOTICE_SUPPORT_EMAIL}
                    </a>
                  </>
                ),
              }
            : {})}
          recipient={firstName}
          handle={profile.handle}
          recognition={profile.recognition === true}
          {...(profile.tipAmounts ? { tipAmounts: profile.tipAmounts } : {})}
          {...(profile.celebration ? { celebration: profile.celebration } : {})}
        />
      )}
    </>
  );
}

/** The page's footer: report, Privacy, Terms, the preview link (locked on a Studio page too). */
function ProfileFoot({
  profile,
  firstName,
  campaign,
  previewPages,
}: {
  profile: PublicProfile;
  firstName: string;
  campaign: boolean;
  previewPages: boolean;
}) {
  return (
    <footer className="profile-foot">
      {campaign && (
        <p className="profile-foot__campaign">
          Tips go to {firstName}.{' '}
          <Link href={`/@${profile.handle}`}>See {firstName}’s main page</Link>
        </p>
      )}
      <div className="profile-foot__quiet">
        <ReportPage handle={profile.handle} />
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        {previewPages && (
          <Link href="/about-preview">Learn about this preview</Link>
        )}
      </div>
      {profile.plan !== 'pro' && (
        <Link className="profile-foot__own" href="/sign-up">
          Get your own TipMe page
        </Link>
      )}
    </footer>
  );
}
