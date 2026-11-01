import Link from 'next/link';
import { QuietScreen } from './quiet-screen';

/**
 * The same screen for unknown, not live, deleted and suspended pages, so a page's existence is
 * never revealed.
 */
// `showDemo`: the fictional demo page exists on test copies only.
export function PageUnavailable({ showDemo }: { showDemo: boolean }) {
  return (
    <QuietScreen
      title="This page isn’t available right now"
      actions={
        <>
          <Link className="tm-button tm-button--primary" href="/">
            Go to TipMe
          </Link>
          {showDemo && (
            <Link className="text-link" href="/@ada">
              See a demo page
            </Link>
          )}
        </>
      }
    >
      <p>
        The link may be mistyped, or the person may have paused their page.
        Please check the link or try again later.
      </p>
    </QuietScreen>
  );
}
