import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { siteOrigin } from '@/lib/metadata';
import { Navigation } from '@/components/navigation';
import { Footer } from '@/components/footer';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import '@tipme/ui/tokens.css';
import '@tipme/ui/components.css';
import './globals.css';

// Both fonts ship in the repository (src/fonts/, SIL OFL 1.1, Latin and Latin Extended only), so a
// build never downloads them and no page makes a third-party font request.
const manrope = localFont({
  src: '../fonts/Manrope-Latin.woff2',
  weight: '200 800',
  variable: '--font-manrope',
  display: 'swap',
});

const dmSerif = localFont({
  src: '../fonts/DMSerifDisplay-Latin.woff2',
  weight: '400',
  style: 'normal',
  variable: '--font-dm-serif',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

export const metadata: Metadata = {
  metadataBase: siteOrigin,
  title: {
    default: 'TipMe — A little thanks goes a long way',
    template: '%s | TipMe',
  },
  description:
    'An appreciation-first way to recognize the people who make a difference. Explore the non-transactional TipMe preview.',
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Font variables must be on <html>: the :root tokens in @tipme/ui resolve them there.
    <html lang="en" className={`${manrope.variable} ${dmSerif.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Navigation />
        {children}
        <Footer />
        <WebVitalsReporter />
      </body>
    </html>
  );
}
