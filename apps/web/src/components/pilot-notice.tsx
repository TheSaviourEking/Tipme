import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeShown,
} from '@/lib/pilot';
import { Suspense } from 'react';
import { getDisplaySettings } from '@/lib/display-settings-api';
import { getPaymentMode } from '@/lib/payment-mode-api';

async function Resolved() {
  const [mode, display] = await Promise.all([
    getPaymentMode(),
    getDisplaySettings(),
  ]);
  return (
    pilotNoticeShown(display, process.env, mode) && (
      <span className="pilot-notice" data-testid="pilot-notice">
        {PILOT_NOTICE_TEXT}{' '}
        <a href={`mailto:${PILOT_NOTICE_SUPPORT_EMAIL}`}>
          {PILOT_NOTICE_SUPPORT_EMAIL}
        </a>
      </span>
    )
  );
}

/**
 * The pilot notice, for the places where money moves (tip form, receipt, dashboard, withdraw).
 * Server-only: pass `<PilotNotice />` into client views as a prop. The setting (admin's, owner 14 Nov
 * 2026, #216) and the payment mode are read per request, so it is never baked in at build and never
 * shows outside live mode.
 */
export function PilotNotice() {
  return (
    <Suspense fallback={null}>
      <Resolved />
    </Suspense>
  );
}
