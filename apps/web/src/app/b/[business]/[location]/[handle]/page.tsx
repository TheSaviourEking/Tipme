import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppreciationForm } from '@/components/appreciation-form';
import { BusinessHeader } from '@/components/business/business-header';
import { BusinessUnavailable } from '@/components/business/business-unavailable';
import { PilotNotice } from '@/components/pilot-notice';
import { PageRetry } from '@/components/profile/page-retry';
import { TipsNotReady } from '@/components/profile/tips-not-ready';
import { TippingOpensSoon } from '@/components/tipping-opens-soon';
import { loadStaffTipPage, withQrSource } from '@/lib/business/public-api';
import { getPaymentMode } from '@/lib/payment-mode-api';
import { profileTippingClosed } from '@/lib/payment-mode';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeShown,
} from '@/lib/pilot';

// A staff tip page at a business (`/b/<business>/<location>/<handle>`, M2, PR B4): the person's
// own tip form, exactly as on their page, with "{name} at {business}". A code for someone no longer
// working here opens their own page (a 307, the tip unlabelled); unknown or not yet verified shows
// the "isn't taking tips" state (M11).
export const instant = false;

type Props = {
  params: Promise<{ business: string; location: string; handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const NOINDEX = { index: false, follow: false } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { business, location, handle } = await params;
  const page = await loadStaffTipPage(business, location, handle);
  if (page === 'unreachable')
    return { title: 'Let’s try that again', robots: NOINDEX };
  if (!page || 'redirectTo' in page)
    return { title: 'Not taking tips', robots: NOINDEX };
  return {
    title: page.business.name,
    robots: NOINDEX,
    openGraph: { title: page.business.name, siteName: 'TipMe' },
  };
}

export default async function BusinessStaffPage({
  params,
  searchParams,
}: Props) {
  const { business, location, handle } = await params;
  const query = await searchParams;
  const page = await loadStaffTipPage(business, location, handle);
  if (page === 'unreachable')
    return (
      <PageRetry
        href={withQrSource(`/b/${business}/${location}/${handle}`, query)}
      />
    );
  if (!page) return <BusinessUnavailable />;
  // Temporary: they may work here again, and the printed code should follow.
  if ('redirectTo' in page) redirect(withQrSource(page.redirectTo, query));
  const { profile, person } = page;
  const mode = await getPaymentMode();
  const copy = paymentModeCopy(mode);
  const pilotShown = pilotNoticeShown(process.env, mode);
  const opensSoon = !copy.payable || profileTippingClosed(mode, profile);
  const firstName = person.shownName;
  return (
    <main id="main" tabIndex={-1} className="profile-page business-staff">
      <div className="profile-sheet business-public__sheet">
        <BusinessHeader
          name={page.business.name}
          location={page.location.name}
          titleLevel="p"
        />
        <h1 className="business-staff__title">
          {firstName} <span>at {page.business.name}</span>
        </h1>
        <aside
          className="profile-composer tip-instrument business-staff__composer"
          aria-label={`Tip ${firstName}`}
          data-tip-panel
        >
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
              {...(profile.tipAmounts
                ? { tipAmounts: profile.tipAmounts }
                : {})}
              business={{
                memberId: person.memberId,
                name: page.business.name,
                slug: page.business.slug,
              }}
            />
          )}
        </aside>
        <footer className="business-public__foot">
          <Link
            href={withQrSource(
              `/b/${page.business.slug}/${page.location.slug}`,
              query,
            )}
          >
            Someone else at {page.location.name}
          </Link>
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
        </footer>
      </div>
    </main>
  );
}
