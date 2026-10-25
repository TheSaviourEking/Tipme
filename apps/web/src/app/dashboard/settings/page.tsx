import type { Metadata } from 'next';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function SettingsPage() {
  return <SettingsView />;
}
