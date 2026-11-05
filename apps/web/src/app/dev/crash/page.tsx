import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

export const metadata: Metadata = {
  title: 'Crash',
  robots: { index: false, follow: false },
};

// Request-time state: a prerendered page that throws would fail the build instead.
export const instant = false;

/**
 * Test copies only: fails on the server so the error screen and its reference can be tested in a
 * production build. Same gate as /dev/inbox: a 404 in a production build unless NEXT_PUBLIC_PRETEND_DELIVERY=on
 * (production must never set it), and open under `next dev`.
 */
export default async function CrashPage() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PUBLIC_PRETEND_DELIVERY !== 'on'
  )
    notFound();
  await connection();
  throw new Error('Deliberate failure to test the error screen.');
}
