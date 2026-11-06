'use client';
import Link from 'next/link';
import { Button, Slip } from '@tipme/ui';
import { slipWords } from '@/lib/whats-new';
import { useWhatsNew } from '@/components/dashboard/whats-new-context';

/**
 * One quiet slip on Home after an update goes live (changelog plan, Design §6): the newest unseen
 * line only. Closing it, or opening What's new, marks it seen on every device, and it does not come
 * back until a newer update goes live.
 */
export function WhatsNewSlip() {
  const { status, markSeen } = useWhatsNew();
  const words = slipWords(status);
  if (!words || !status?.newest) return null;
  const through = status.newest.liveAt;

  const close = () => {
    void markSeen(through);
    // The slip is gone: focus goes to the page's first heading, not back to the top of the page.
    const heading = document.querySelector<HTMLElement>(
      '.dashboard-home__main h1',
    );
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus();
  };

  return (
    <div className="whats-new-slip">
      <Slip
        tone="neutral"
        title={words.title}
        live="none"
        actions={
          <>
            <Link
              className="tm-button tm-button--secondary"
              data-material="raised"
              href="/dashboard/whats-new"
            >
              See what’s new
            </Link>
            <Button variant="quiet" onClick={close}>
              Close
            </Button>
          </>
        }
      >
        <p>
          {words.line}
          {words.more && (
            <>
              {' '}
              <span className="tm-hint">({words.more})</span>
            </>
          )}
        </p>
      </Slip>
    </div>
  );
}
