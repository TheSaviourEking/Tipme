import { ActionLink } from '@tipme/ui';
import Link from 'next/link';
import { QuietScreen } from './quiet-screen';

/**
 * The same screen for unknown, not live, deleted and suspended pages, so a page's existence is
 * never revealed. It therefore never names the handle.
 */
// `showDemo`: the fictional demo page exists on test copies only.
export function PageUnavailable({ showDemo }: { showDemo: boolean }) {
  return (
    <QuietScreen
      title="This page isn’t available right now"
      action={
        <ActionLink variant="continue" href="/">
          Go to TipMe
        </ActionLink>
      }
      foot={
        <>
          <Link className="text-link" href="/sign-up">
            Get your own page
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
