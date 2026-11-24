import {
  GetTippedWords,
  HeaderBusinessStart,
} from '@/components/release-flags-slot';
import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import localFont from 'next/font/local';
import { withGlyphFallback } from '@/lib/font-stack';
import { siteOrigin } from '@/lib/metadata';
import { Navigation } from '@/components/navigation';
import { BusinessesWho } from '@/components/business/businesses-who';
import { Footer } from '@/components/footer';
import { UpdateNotice } from '@/components/update-notice';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import { SITE_DESCRIPTION } from '@/lib/payment-mode-copy';
import '@tipme/ui/tokens.css';
import '@tipme/ui/components.css';
import './globals.css';

// The fonts ship in the repository (src/fonts/, SIL OFL 1.1), so a build
// never downloads them and no page makes a third-party font request.
const manrope = localFont({
  src: '../fonts/Manrope-Latin.woff2',
  weight: '200 800',
  display: 'swap',
});

const dmSerif = localFont({
  src: '../fonts/DMSerifDisplay-Latin.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

// Money is set in Inter (owner, 17 Nov 2026): it draws ₦ and has tabular figures. Not preloaded:
// it is never the largest paint, and a page with no amount never asks for it.
const interMoney = localFont({
  src: '../fonts/Inter-400-700.woff2',
  weight: '400 700',
  variable: '--font-inter',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
});

// The same file as the backup for the letters Manrope and DM Serif Display lack (₦, ẹ ọ ṣ, the
// combining dot below, ɓ ɗ ƙ ƴ), so a name is never drawn letter by letter in a system font.
// The range must equal GLYPH_FALLBACK_RANGE (lib/font-stack.ts; next/font takes literals only).
const interGlyphs = localFont({
  src: '../fonts/Inter-400-700.woff2',
  weight: '400 700',
  variable: '--font-glyph-fallback',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value: 'U+20A6, U+0300-036F, U+0180-024F, U+0250-02AF, U+1E00-1EFF',
    },
  ],
});

// The interface and editorial stacks, each with the glyph fallback straight after the face.
const fontStacks = {
  '--font-manrope': withGlyphFallback(
    manrope.style.fontFamily,
    interGlyphs.style.fontFamily,
  ),
  '--font-dm-serif': withGlyphFallback(
    dmSerif.style.fontFamily,
    interGlyphs.style.fontFamily,
  ),
} as CSSProperties;

export const metadata: Metadata = {
  metadataBase: siteOrigin,
  title: {
    default: 'TipMe — A little tip goes a long way',
    template: '%s | TipMe',
  },
  description: SITE_DESCRIPTION,
  robots: { index: false, follow: false },
  // The heart of two figures on a white tile (public/icons, scripts/design/brand-assets.mjs).
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-48.png', sizes: '48x48', type: 'image/png' },
    ],
    apple: {
      url: '/icons/apple-touch-icon.png',
      sizes: '180x180',
      type: 'image/png',
    },
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Font variables must be on <html>: the :root tokens in @tipme/ui resolve them there.
    <html
      lang="en"
      className={`${interMoney.variable} ${interGlyphs.variable}`}
      style={fontStacks}
    >
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Navigation
          businesses={<BusinessesWho />}
          claimWords={<GetTippedWords />}
          businessStart={<HeaderBusinessStart />}
        />
        {children}
        <Footer />
        <UpdateNotice />
        <WebVitalsReporter />
      </body>
    </html>
  );
}
