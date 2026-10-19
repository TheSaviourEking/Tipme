import type { Metadata } from 'next';
import { QrStudio } from './qr-studio';

export const metadata: Metadata = { title: 'My QR code' };

export default function QrPage() {
  return <QrStudio />;
}
