import type { Metadata } from 'next';
import { QrStudio } from './qr-studio';

export const metadata: Metadata = { title: 'My QR code' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function QrPage() {
  return <QrStudio />;
}
