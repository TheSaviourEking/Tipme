import type { Metadata } from 'next';
import { StudioEditorRoute } from './studio-editor';

export const metadata: Metadata = { title: 'Page Studio' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function StudioPage() {
  return <StudioEditorRoute />;
}
