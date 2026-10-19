import Link from 'next/link';
import { Container } from '@tipme/ui';

/**
 * The same screen for unknown, not live, deleted and suspended pages, so a page's existence is
 * never revealed.
 */
export function PageUnavailable() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="unavailable-page">
        <span className="review-flower" aria-hidden="true">
          ✳
        </span>
        <h1>This page isn’t available right now</h1>
        <p>
          The link may be mistyped, or the person may have paused their page.
          Please check the link or try again later.
        </p>
        <Link className="text-link" href="/">
          Go to TipMe
        </Link>
      </Container>
    </main>
  );
}
