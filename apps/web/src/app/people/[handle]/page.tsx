import Link from 'next/link';
import { permanentRedirect } from 'next/navigation';
import { resolveCover, type PublicProfile } from '@tipme/contracts';
import { AppreciationForm, type TipSkin } from '@/components/appreciation-form';
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
import { StandardProfile } from '@/components/profile/standard-profile';
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
import { studioFor } from '@/lib/public-studio';
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
  // Page Studio (styles spec §13): a published design, sent by the API only while the
  // `page_studio` switch is on, as the page's plan shows it. Null (no design, a campaign link,
  // Classic with every default, or whatever the plan hides) renders today's page below, unchanged.
  const studio = studioFor(profile, {
    apiOrigin: BROWSER_API_ORIGIN,
    labImages: studioLabOpen(),
    ...(campaign ? { campaign } : {}),
  });
  if (studio) {
    // Loaded only here, so a page without a design carries none of it.
    const { renderStyled } =
      await import('@/components/studio-styles/style-page');
    const style = studio.document.style;
    const tracker = <ProfileViewTracker handle={profile.handle} />;
    const styled = renderStyled({
      studio,
      profile,
      coverArt: coverView,
      // Classic keeps TipMe's identity block, links and bio where today's page has them.
      identity: (
        <RecipientIdentity
          profile={profile}
          firstName={firstName}
          celebrationLabel={
            takesTips ? (profile.celebration?.label ?? null) : null
          }
        />
      ),
      lead: tracker,
      tipBlock: (
        <TipBlock
          profile={profile}
          firstName={firstName}
          mode={mode}
          opensSoon={opensSoon}
          pilotShown={pilotShown}
          // Classic's tip form is today's: no skin.
          {...(style === 'classic' ? {} : { skin: style })}
        />
      ),
      footer: (
        <ProfileFoot
          profile={profile}
          firstName={firstName}
          campaign={false}
          previewPages={copy.previewPages}
        />
      ),
    });
    // Classic renders today's page, whose root is its own <main>. A new style sits in a plain
    // <main>: not `.profile-page`, so the site's header and footer show, blended into the page
    // (frame.css, chromeCss), and the standard page's Tip-bar padding stays off it (the frame
    // keeps its own room for its bar).
    if (style === 'classic') return styled;
    return (
      <main id="main" tabIndex={-1} className="studio-main">
        {tracker}
        {styled}
      </main>
    );
  }
  return (
    <StandardProfile
      firstName={firstName}
      lead={<ProfileViewTracker handle={profile.handle} />}
      cover={coverView}
      identity={
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
          campaign={Boolean(campaignPage)}
          previewPages={copy.previewPages}
        />
      }
    />
  );
}

/** TipMe's tip block: the same form on every page; a style changes only its skin (§13). */
function TipBlock({
  profile,
  firstName,
  mode,
  opensSoon,
  pilotShown,
  skin,
}: {
  profile: PublicProfile;
  firstName: string;
  mode: PaymentMode;
  opensSoon: boolean;
  pilotShown: boolean;
  /** A styled page's form skin (class names and tokens only, §13). */
  skin?: TipSkin;
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
          {...(skin ? { skin } : {})}
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
