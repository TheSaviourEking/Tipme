import type { Metadata } from 'next';
import { BusinessUnavailable } from '@/components/business/business-unavailable';

// A staff tip page at a business (`/b/<business>/<location>/<handle>`, M2). B4 fills it; until then
// it shows the "isn't taking tips" state, with a 200 and noindex (M11).
export const metadata: Metadata = {
  title: 'Not taking tips',
  robots: { index: false, follow: false },
};

export default function BusinessStaffPage() {
  return <BusinessUnavailable />;
}
