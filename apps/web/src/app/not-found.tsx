import Link from 'next/link';
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
          <Link className="text-link" href="/@ada">
            See a demo page
          </Link>
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
