import type { Metadata } from 'next';
import { BusinessUnavailable } from '@/components/business/business-unavailable';

// A business location page (`/b/<business>/<location>`). B4 fills it; until then every location
// shows the "isn't taking tips" state, with a 200 and noindex (M11).
export const metadata: Metadata = {
  title: 'Not taking tips',
  robots: { index: false, follow: false },
};

export default function BusinessLocationPage() {
  return <BusinessUnavailable />;
}
