import type { Metadata } from 'next';
import WhatsNewPage from './whats-new-view';

export const metadata: Metadata = { title: 'What’s new' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default WhatsNewPage;
