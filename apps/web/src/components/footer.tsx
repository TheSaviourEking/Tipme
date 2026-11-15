import Link from 'next/link';
import { Container } from '@tipme/ui';
import { PaymentModeSlot, TestModeOnly } from './payment-mode-slot';
import { Brand } from './brand';

const groups = [
  {
    title: 'TipMe',
    links: [
      { href: '/#how-it-works', label: 'How it works' },
      { href: '/for-creators', label: 'For individuals' },
      { href: '/for-businesses', label: 'For Businesses' },
      { href: '/#our-promise', label: 'Our promise' },
    ],
  },
  {
    title: 'Get started',
    links: [
      { href: '/sign-up', label: 'Create your page' },
      { href: '/@ada', label: 'Try the demo', testOnly: true },
      { href: '/sign-in', label: 'Sign in' },
    ],
  },
  {
    title: 'About',
    links: [
      { href: '/about-preview', label: 'About this preview', testOnly: true },
      { href: '/legal/privacy', label: 'Privacy' },
      { href: '/legal/terms', label: 'Terms' },
    ],
  },
] as const;

export function Footer() {
  return (
    <footer className="site-footer">
      <Container>
        <div className="footer-card">
          <div className="footer-brand">
            <Brand />
            <p>For the people who make a difference.</p>
          </div>
          <nav aria-label="Footer navigation" className="footer-nav">
            {groups.map((group) => (
              <div key={group.title}>
                <h2 className="footer-heading">{group.title}</h2>
                <ul>
                  {group.links.map((link) => {
                    const item = (
                      <li key={link.href}>
                        <Link href={link.href}>{link.label}</Link>
                      </li>
                    );
                    // The fictional demo and the preview notes exist on test copies only.
                    return 'testOnly' in link ? (
                      <TestModeOnly key={link.href}>{item}</TestModeOnly>
                    ) : (
                      item
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="footer-bottom">
          <span>© 2026 TipMe. A little tip goes a long way.</span>
          <PaymentModeSlot>
            {(_mode, copy) => copy.footerNote && <span>{copy.footerNote}</span>}
          </PaymentModeSlot>
          {/* Shown only in the signed-in app's slim footer (X1), where the full card is hidden;
              elsewhere the card lists them, so this stays out of view and out of the a11y tree. */}
          <nav aria-label="Legal" className="footer-legal">
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
          </nav>
        </div>
      </Container>
    </footer>
  );
}
