import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@tipme/ui';
import { InboxView } from './inbox-view';

export const metadata: Metadata = {
  title: 'Pretend inbox',
  robots: { index: false, follow: false },
};

/** Development only: codes and emails the pretend messenger and mailbox "sent". */
export default function PretendInboxPage() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PUBLIC_PRETEND_DELIVERY !== 'on'
  )
    notFound();
  return (
    <main id="main" tabIndex={-1} className="inbox-page">
      <Container className="section-space">
        <h1>Pretend inbox</h1>
        <p className="tm-hint">
          Development only. Nothing here was really sent: there is no messaging
          provider yet.
        </p>
        <InboxView />
      </Container>
    </main>
  );
}
