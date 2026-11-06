import { ImageResponse } from 'next/og';
import { IconTile } from '@/lib/app-icons';

// The home-screen icon for iPhone and iPad: full bleed, iOS rounds it. Request-independent, so it
// is prerendered at build.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<IconTile size={180} />, size);
}
