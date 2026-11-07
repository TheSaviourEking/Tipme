import type { Metadata } from 'next';
import { WorkView } from './work-view';

export const metadata: Metadata = { title: 'Work' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function WorkPage() {
  return <WorkView />;
}
