import type { Metadata } from 'next';
import { siteOrigin } from '@/lib/metadata';
import { Navigation } from '@/components/navigation';
import { Footer } from '@/components/footer';
import '@tipme/ui/tokens.css';
import '@tipme/ui/components.css';
import './globals.css';

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
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Navigation />
        {children}
        <Footer />
      </body>
    </html>
  );
}
