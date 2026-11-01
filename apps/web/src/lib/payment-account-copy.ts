// The payment account card's words, by Bachs environment. A live copy pays real recipients, so
// its card never calls itself a test; null is before the account (and so its environment) loads.
export type PaymentAccountCopy = {
  heading: string;
  intro: string;
  ready: string;
  setUp: string;
  verifyEmailFirst: string;
};

const SANDBOX: PaymentAccountCopy = {
  heading: 'Test payments',
  intro:
    'Sandbox only: no real money moves. Set up a test payment account so supporters can tip you during testing.',
  ready: 'Ready to receive test tips',
  setUp: 'Set up test payments',
  verifyEmailFirst:
    'Verify your email address first, then set up test payments.',
};

const LIVE: PaymentAccountCopy = {
  heading: 'Payments',
  intro:
    'This is the account Bachs pays your tips into. You set it up with Bachs.',
  ready: 'Ready to receive tips',
  setUp: 'Set up payments',
  verifyEmailFirst: 'Verify your email address first, then set up payments.',
};

export function paymentAccountCopy(
  environment: 'sandbox' | 'live' | null,
): PaymentAccountCopy {
  if (environment === 'sandbox') return SANDBOX;
  // Live, and the neutral loading state: only the heading is ever shown before the account loads.
  return LIVE;
}
