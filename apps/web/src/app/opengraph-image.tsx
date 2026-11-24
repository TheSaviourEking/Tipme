import { ImageResponse } from 'next/og';
import { shareCard } from '@/lib/metadata';
import { GeneralCard, ogFonts, shareArt } from '@/lib/share-card';

// Shared, request-independent card: prerendered at build. Never include per-visitor or draft data here.
export const alt = shareCard.alt;
export const size = { width: shareCard.width, height: shareCard.height };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  return new ImageResponse(<GeneralCard art={await shareArt()} />, {
    ...size,
    fonts: await ogFonts(),
  });
}
