import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeShown,
} from '@/lib/pilot';
import { PaymentModeSlot } from './payment-mode-slot';

/**
 * The pilot notice, for the places where money moves (tip form, receipt, dashboard, withdraw).
 * Server-only: pass `<PilotNotice />` into client views as a prop. The setting is read inside the
 * render function, after the payment mode is known for this request, so it is never baked in at
 * build and never shows outside live mode.
 */
export function PilotNotice() {
  return (
    <PaymentModeSlot>
      {(mode) =>
        pilotNoticeShown(process.env, mode) && (
          <span className="pilot-notice" data-testid="pilot-notice">
            {PILOT_NOTICE_TEXT}{' '}
            <a href={`mailto:${PILOT_NOTICE_SUPPORT_EMAIL}`}>
              {PILOT_NOTICE_SUPPORT_EMAIL}
            </a>
          </span>
        )
      }
    </PaymentModeSlot>
  );
}
