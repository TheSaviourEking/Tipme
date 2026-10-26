import Link from 'next/link';
import { Container } from '@tipme/ui';
import { Brand } from './brand';

const groups = [
  {
    title: 'TipMe',
    links: [
      { href: '/how-it-works', label: 'How it works' },
      { href: '/for-creators', label: 'For creators' },
      { href: '/#our-promise', label: 'Our promise' },
    ],
  },
  {
    title: 'Get started',
    links: [
      { href: '/sign-up', label: 'Create your page' },
      { href: '/@ada', label: 'Try the demo' },
      { href: '/sign-in', label: 'Sign in' },
    ],
  },
  {
    title: 'About',
    links: [
      { href: '/about-preview', label: 'About this preview' },
      { href: '/design-system', label: 'Design foundation' },
      { href: '/legal/privacy', label: 'Privacy (placeholder)' },
      { href: '/legal/terms', label: 'Terms (placeholder)' },
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
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href}>{link.label}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="footer-bottom">
          <span>© 2026 TipMe. A little thanks goes a long way.</span>
          <span>Development preview · Pretend payments only</span>
        </div>
      </Container>
    </footer>
  );
}
