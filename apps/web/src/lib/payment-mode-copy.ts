import type { PaymentMode } from './payment-mode';

// Every sentence that used to claim "test mode" outright, by payment mode. test keeps the
// wording it always had; closed and live copies run Bachs live, so they never say test,
// sandbox or "no real money". null means the line is not shown in that mode.
export type PaymentModeCopy = {
  /** Whether a supporter can pay: false hides the tip form and its pay button. */
  payable: boolean;
  closedTitle: string;
  closedBody: string;
  formBadge: string | null;
  formDisclaimer: string | null;
  profileSafety: string;
  profileMetaSuffix: string;
  homeRecipientNotice: string | null;
  homeClarity: string;
  howItWorksPay: string;
  signUpLede: string;
  dashboardBadge: string | null;
  dashboardPaymentStep: string;
  qrHint: string;
  withdrawNotice: string | null;
  withdrawDoneSuffix: string;
  tipFeesPrefix: string;
  receiptBanner: string | null;
  footerNote: string | null;
  weekCardSuffix: string;
  opsBilling: string;
};

const CLOSED_TITLE = 'Tipping opens soon';
const CLOSED_BODY = 'TipMe isn’t taking tips yet. Please come back soon.';
const SIGN_UP =
  'An email address and a handle is all it takes to start receiving thanks.';
const CLARITY =
  'You see the full cost and what the person receives before you pay.';
const PAY_STEP = 'Review the full amount and what they receive, then pay.';

const TEST: PaymentModeCopy = {
  payable: true,
  closedTitle: CLOSED_TITLE,
  closedBody: CLOSED_BODY,
  formBadge: 'Test payments',
  formDisclaimer: 'TipMe is in test mode: no real money moves yet.',
  profileSafety:
    'No account needed. TipMe is in test mode: no real money moves yet.',
  profileMetaSuffix: ' Test mode.',
  homeRecipientNotice:
    'Payments are in test mode. Real payments and payout setup are not available until provider and funds-flow approvals are complete.',
  homeClarity: `${CLARITY} Payments are still in test mode; real payments are not available yet.`,
  howItWorksPay: `${PAY_STEP} Payments are still in test mode; real payments are not available yet.`,
  signUpLede: `${SIGN_UP} Payments are in test mode.`,
  dashboardBadge: 'Test mode',
  dashboardPaymentStep:
    'Supporters can tip you. No real money moves in test mode.',
  qrHint: 'Anyone who scans it lands on your page. Test mode.',
  withdrawNotice:
    'No real money moves in test mode. The test bank pays straight away.',
  withdrawDoneSuffix: ' is on its way to your test bank.',
  tipFeesPrefix: 'Test mode · fees from policy',
  receiptBanner: 'Test payment · no real money moved',
  footerNote: 'Development preview · Test mode',
  weekCardSuffix: ' · test mode',
  opsBilling: 'There is no billing while payments are in test mode.',
};

const LIVE: PaymentModeCopy = {
  payable: true,
  closedTitle: CLOSED_TITLE,
  closedBody: CLOSED_BODY,
  formBadge: null,
  formDisclaimer: null,
  profileSafety: 'No account needed.',
  profileMetaSuffix: '',
  homeRecipientNotice: null,
  homeClarity: CLARITY,
  howItWorksPay: PAY_STEP,
  signUpLede: SIGN_UP,
  dashboardBadge: null,
  dashboardPaymentStep: 'Supporters can tip you.',
  qrHint: 'Anyone who scans it lands on your page.',
  withdrawNotice: null,
  withdrawDoneSuffix: ' is on its way to your bank.',
  tipFeesPrefix: 'Fees from policy',
  receiptBanner: null,
  footerNote: null,
  weekCardSuffix: '',
  opsBilling: 'There is no billing for Pro yet.',
};

const CLOSED: PaymentModeCopy = {
  ...LIVE,
  payable: false,
  profileSafety: `No account needed. ${CLOSED_TITLE}.`,
  homeRecipientNotice: `${CLOSED_TITLE}. You can create your page now.`,
  homeClarity: `${CLARITY} ${CLOSED_TITLE}.`,
  howItWorksPay: `${PAY_STEP} ${CLOSED_TITLE}.`,
  signUpLede: `${SIGN_UP} ${CLOSED_TITLE}.`,
  dashboardPaymentStep: `${CLOSED_TITLE}. Set up payments so you’re ready.`,
};

export function paymentModeCopy(mode: PaymentMode): PaymentModeCopy {
  if (mode === 'test') return TEST;
  if (mode === 'live') return LIVE;
  return CLOSED;
}
