import type { Metadata } from 'next';
import { DM_Serif_Display, Manrope } from 'next/font/google';
import { siteOrigin } from '@/lib/metadata';
import { Navigation } from '@/components/navigation';
import { Footer } from '@/components/footer';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import '@tipme/ui/tokens.css';
import '@tipme/ui/components.css';
import './globals.css';

// Self-hosted at build time via next/font — no runtime external request.
const manrope = Manrope({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});

const dmSerif = DM_Serif_Display({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-dm-serif',
  display: 'swap',
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
