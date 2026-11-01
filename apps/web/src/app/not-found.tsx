import Link from 'next/link';
import { TestModeOnly } from '@/components/payment-mode-slot';
import { QuietScreen } from '@/components/quiet-screen';

export default function NotFound() {
  return (
    <QuietScreen
      title="We can’t find that page"
      actions={
        <>
          <Link className="tm-button tm-button--primary" href="/">
            Go to TipMe
          </Link>
          <TestModeOnly>
            <Link className="text-link" href="/@ada">
              See a demo page
            </Link>
          </TestModeOnly>
        </>
      }
    >
      <p>
        The link may be mistyped, or the page may have moved. Looking for
        someone? Ask them for their TipMe link or QR code.
      </p>
    </QuietScreen>
  );
}
