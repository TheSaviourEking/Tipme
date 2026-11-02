import Link from 'next/link';
import { QuietScreen } from '@/components/quiet-screen';

/**
 * TipMe couldn't look the page up, which says nothing about the page itself. Rendered on the
 * server with a plain link, so it works without scripts and asks again with a full load.
 */
export function PageRetry({ href }: { href: string }) {
  return (
    <QuietScreen
      title="Let’s try that again"
      actions={
        <>
          <a className="tm-button tm-button--primary" href={href}>
            Try again
          </a>
          <Link className="text-link" href="/">
            Back to TipMe
          </Link>
        </>
      }
    >
      <p>
        We couldn’t load this page. No appreciation has been sent, so nothing is
        lost.
      </p>
    </QuietScreen>
  );
}
