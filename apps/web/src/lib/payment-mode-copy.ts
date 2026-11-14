import type { PaymentMode } from './payment-mode';

// Every sentence that used to claim "test mode" outright, by payment mode. test keeps the
// wording it always had; closed and live copies run Bachs live, so they never say test,
// sandbox or "no real money". null means the line is not shown in that mode.
export type PaymentModeCopy = {
  /** Whether a supporter can pay: false hides the tip form and its pay button. */
  payable: boolean;
  /** /about-preview and links to the fictional demo page: they describe a test copy only. */
  previewPages: boolean;
  /** The home page's panel beside fictional Ada: a working form only where no money is real. */
  homeDemo: 'form' | 'closed' | 'example';
  homeDemoCaption: string;
  homeExampleTitle: string;
  homeExampleBody: string;
  closedTitle: string;
  closedBody: string;
  formBadge: string | null;
  formDisclaimer: string | null;
  /** Beside the Tip button on the public page, wherever a supporter can pay. */
  formTrust: string | null;
  /** Beside the Tip action, wherever a supporter can pay: who handles the payment, and where. */
  formPartner: string | null;
  profileMetaSuffix: string;
  homeRecipientNotice: string | null;
  homeClarity: string;
  signUpLede: string;
  dashboardBadge: string | null;
  /** After the badge on a wide screen: what the mode means, in a few words. */
  dashboardBadgeDetail: string | null;
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
const CLOSED_BODY =
  'Claim your own page while you wait. No bank details needed yet.';
const SIGN_UP =
  'An email address and a handle is all it takes to start receiving tips.';
const CLARITY = 'You pay exactly the amount you choose.';
const TRUST = 'No account needed. You pay exactly this amount.';
/**
 * Live mode's one line beside the Tip key (TipForm board, public-boards PR 9). True because the
 * form starts nothing unless the quote's tipMinor and payerTotalMinor equal the key's amount, and
 * a provider event books nothing unless it matches payerTotalMinor exactly.
 */
const PARTNER = 'You pay exactly this. You’ll confirm on our partner’s page.';
const EXAMPLE_TITLE = 'Tip the people you know';
const EXAMPLE_BODY =
  'Ada is a fictional example. To send a tip, open the TipMe page of the person you want to tip.';

/** Page descriptions prerendered for every mode, so they hold in all three. */
export const SITE_DESCRIPTION =
  'An appreciation-first way to recognize the people who make a difference.';
/** The share card is prerendered once and shown on every page of every copy. */
export const SHARE_CARD_ALT = 'TipMe. A little thanks goes a long way.';
export const HOME_DESCRIPTION =
  'For the people who make your day, your work, your world a little better.';

const TEST: PaymentModeCopy = {
  payable: true,
  previewPages: true,
  homeDemo: 'form',
  homeDemoCaption: 'A fictional demo recipient. Go on, try the feeling.',
  homeExampleTitle: EXAMPLE_TITLE,
  homeExampleBody: EXAMPLE_BODY,
  closedTitle: CLOSED_TITLE,
  closedBody: CLOSED_BODY,
  formBadge: 'Test payments',
  formDisclaimer: 'TipMe is in test mode: no real money moves yet.',
  formTrust: TRUST,
  // No real partner takes a test tip: the pretend provider's page does.
  formPartner: 'A test page stands in for our payment partner. Confirm there.',
  profileMetaSuffix: ' Test mode.',
  homeRecipientNotice:
    'Payments are in test mode. Real payments and payout setup are not available until provider and funds-flow approvals are complete.',
  homeClarity: `${CLARITY} Payments are still in test mode; real payments are not available yet.`,
  signUpLede: `${SIGN_UP} Payments are in test mode.`,
  dashboardBadge: 'Test mode',
  dashboardBadgeDetail: 'no real money moves',
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
  previewPages: false,
  homeDemo: 'example',
  homeDemoCaption: 'A fictional demo recipient.',
  homeExampleTitle: EXAMPLE_TITLE,
  homeExampleBody: EXAMPLE_BODY,
  closedTitle: CLOSED_TITLE,
  closedBody: CLOSED_BODY,
  formBadge: null,
  formDisclaimer: null,
  // The one line under the Tip key says it (PARTNER).
  formTrust: null,
  formPartner: PARTNER,
  profileMetaSuffix: '',
  homeRecipientNotice: null,
  homeClarity: CLARITY,
  signUpLede: SIGN_UP,
  dashboardBadge: null,
  dashboardBadgeDetail: null,
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
  homeDemo: 'closed',
  formTrust: null,
  formPartner: null,
  homeRecipientNotice: `${CLOSED_TITLE}. You can create your page now.`,
  homeClarity: `${CLARITY} ${CLOSED_TITLE}.`,
  signUpLede: `${SIGN_UP} ${CLOSED_TITLE}.`,
  dashboardPaymentStep: `${CLOSED_TITLE}. Set up payments so you’re ready.`,
};

export function paymentModeCopy(mode: PaymentMode): PaymentModeCopy {
  if (mode === 'test') return TEST;
  if (mode === 'live') return LIVE;
  return CLOSED;
}
