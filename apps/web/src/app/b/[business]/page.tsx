import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BusinessHeader } from '@/components/business/business-header';
import { BusinessManagerNote } from '@/components/business/business-manager-note';
import { BusinessUnavailable } from '@/components/business/business-unavailable';
import { PageRetry } from '@/components/profile/page-retry';
import { loadPublicBusiness, withQrSource } from '@/lib/business/public-api';

// The business page (`/b/<business>`, BusinessProfile board Variant A, approved 6 Nov 2026): the
// business and a card per open location, never a person. One open location sends people straight
// to it with a temporary redirect, so the page appears by itself when a second one opens. Anything
// else (waiting, paused, every place closed, unknown) is the location page's quiet screen, 200 and
// noindex (M11). Wait for the cached answer, as the location page does.
export const instant = false;

type Props = {
  params: Promise<{ business: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const NOINDEX = { index: false, follow: false } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { business } = await params;
  const page = await loadPublicBusiness(business);
  if (page === 'unreachable')
    return { title: 'Let’s try that again', robots: NOINDEX };
  if (!page) return { title: 'Not taking tips', robots: NOINDEX };
  return {
    title: page.business.name,
    robots: NOINDEX,
    openGraph: { title: page.business.name, siteName: 'TipMe' },
  };
}

function PlaceIcon() {
  return (
    <span className="business-place__pin" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
        <path
          d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="12" cy="10" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

export default async function BusinessPage({ params, searchParams }: Props) {
  const { business } = await params;
  const query = await searchParams;
  const page = await loadPublicBusiness(business);
  if (page === 'unreachable')
    return <PageRetry href={withQrSource(`/b/${business}`, query)} />;
  if (!page)
    return (
      <BusinessUnavailable
        lead={<BusinessManagerNote business={business} shown="unavailable" />}
      />
    );
  const { slug, name } = page.business;
  const [only, ...others] = page.locations;
  // Proxy answers this case with a real 307 (lib/business/single-place.ts); this covers a moment
  // when its half-minute memory and this page's cache disagree.
  if (only && others.length === 0)
    redirect(withQrSource(`/b/${slug}/${only.slug}`, query));
  const count = page.locations.length;
  return (
    <main id="main" tabIndex={-1} className="business-public business-home">
      <div className="business-public__sheet">
        <BusinessManagerNote business={slug} shown="places" />
        <BusinessHeader
          name={name}
          where={`${count} ${count === 1 ? 'place' : 'places'}`}
          titleLevel="h1"
          logoPath={page.business.logoPath}
        />
        <p className="business-public__ask">
          Where are you? Pick the place to see who’s working there and tip them.
          The tip goes to them.
        </p>
        <nav aria-label="Places">
          <ul className="business-places">
            {page.locations.map((location) => (
              <li key={location.slug}>
                <Link
                  className="business-place"
                  href={`/b/${slug}/${location.slug}`}
                >
                  <PlaceIcon />
                  <span className="business-place__words">
                    <span className="business-place__name">
                      {location.name}
                    </span>
                    <span className="business-place__address">
                      {location.address}
                    </span>
                  </span>
                  <svg
                    className="business-place__chevron"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M9 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <footer className="business-public__foot">
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
        </footer>
      </div>
    </main>
  );
}
