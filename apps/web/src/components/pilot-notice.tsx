import { Suspense } from 'react';
import { connection } from 'next/server';
import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeOn,
} from '@/lib/pilot';

// Server-only. PILOT_NOTICE is read for each request, never baked in at build, so it is a server
// setting like PREVIEW_PASSWORD: no NEXT_PUBLIC_ twin, nothing in the client bundle. It lives in
// the footer on purpose, so it never pushes the tip action down or hides content.
async function Notice() {
  await connection();
  if (!pilotNoticeOn(process.env)) return null;
  return (
    <p className="pilot-notice" data-testid="pilot-notice">
      {PILOT_NOTICE_TEXT}{' '}
      <a href={`mailto:${PILOT_NOTICE_SUPPORT_EMAIL}`}>
        {PILOT_NOTICE_SUPPORT_EMAIL}
      </a>
    </p>
  );
}

export function PilotNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
