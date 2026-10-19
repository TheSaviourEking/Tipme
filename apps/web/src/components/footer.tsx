import Link from 'next/link';
import { Container } from '@tipme/ui';
import { Brand } from './brand';
export function Footer() {
  return (
    <footer className="site-footer">
      <Container>
        <div className="footer-top">
          <div>
            <Brand />
            <p>For the people who make a difference.</p>
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/@ada">Try the demo</Link>
            <Link href="/about-preview">About this preview</Link>
            <Link href="/design-system">Design foundation</Link>
            <Link href="/legal/privacy">Privacy (placeholder)</Link>
            <Link href="/legal/terms">Terms (placeholder)</Link>
          </nav>
        </div>
        <div className="footer-bottom">
          <span>© 2026 TipMe. A little thanks goes a long way.</span>
          <span>Development preview · No payments available</span>
        </div>
      </Container>
    </footer>
  );
}
