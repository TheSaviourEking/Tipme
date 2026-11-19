import type { Metadata } from 'next';
import { ClaimView } from './claim-view';

// A username claim link (handover, 18 Nov 2026): `/sign-up/claim#claim=<code>`. The code is in the
// fragment, so this page is the same for everyone and the server never sees it.
export const metadata: Metadata = {
  title: 'Claim your username',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ClaimPage() {
  return <ClaimView />;
}
