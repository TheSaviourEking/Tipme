import Link from 'next/link';
import { EmptyWell } from '@tipme/ui';

/**
 * A missing admin page keeps the frame and its menu (UI audit F25). The layout shows it only to
 * staff with access; anyone else gets the ordinary missing page, so the admin area isn't revealed.
 */
export default function OpsNotFound() {
  return (
    <div className="ops-page-body">
      <h1>Not found</h1>
      <EmptyWell
        title="There’s no admin page here"
        action={<Link href="/ops">Go to the Overview</Link>}
      >
        <p>The link may be mistyped, or the page may have moved.</p>
      </EmptyWell>
    </div>
  );
}
