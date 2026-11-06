import type { Metadata } from 'next';
import { BusinessView } from './business-view';

export const metadata: Metadata = { title: 'Business' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function BusinessPage() {
  return <BusinessView />;
}
