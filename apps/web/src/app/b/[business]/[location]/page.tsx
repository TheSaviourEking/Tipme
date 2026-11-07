import type { Metadata } from 'next';
import Link from 'next/link';
import { BusinessHeader } from '@/components/business/business-header';
import { BusinessUnavailable } from '@/components/business/business-unavailable';
import { StaffPicker } from '@/components/business/staff-picker';
import { PageRetry } from '@/components/profile/page-retry';
import { loadPublicLocation, withQrSource } from '@/lib/business/public-api';

// A business location page (`/b/<business>/<location>`, PR B4): the printed location code opens
// it. Unknown, waiting, paused or closed shows the "isn't taking tips" state, 200 and noindex (M11).
// Wait for the cached answer rather than stream a silhouette, as a person's page does.
export const instant = false;

type Props = {
  params: Promise<{ business: string; location: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// A location page lists people: never indexed. Its preview names the business only.
const NOINDEX = { index: false, follow: false } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { business, location } = await params;
  const page = await loadPublicLocation(business, location);
  if (page === 'unreachable')
    return { title: 'Let’s try that again', robots: NOINDEX };
  if (!page) return { title: 'Not taking tips', robots: NOINDEX };
  return {
    title: page.business.name,
    robots: NOINDEX,
    openGraph: { title: page.business.name, siteName: 'TipMe' },
  };
}

export default async function BusinessLocationPage({
  params,
  searchParams,
}: Props) {
  const { business, location } = await params;
  const query = await searchParams;
  const page = await loadPublicLocation(business, location);
  if (page === 'unreachable')
    return (
      <PageRetry href={withQrSource(`/b/${business}/${location}`, query)} />
    );
  if (!page) return <BusinessUnavailable />;
  return (
    <main id="main" tabIndex={-1} className="business-public">
      <div className="business-public__sheet">
        <BusinessHeader
          name={page.business.name}
          location={page.location.name}
          titleLevel="h1"
        />
        <p className="business-public__ask">
          Who served you? Tap their name to tip them. The tip goes to them.
        </p>
        <StaffPicker
          business={page.business.slug}
          businessName={page.business.name}
          location={page.location.slug}
          locationName={page.location.name}
          people={page.people}
          qr={query['src'] === 'qr'}
        />
        <footer className="business-public__foot">
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
        </footer>
      </div>
    </main>
  );
}
