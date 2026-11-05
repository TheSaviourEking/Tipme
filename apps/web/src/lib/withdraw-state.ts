import type { WithdrawalQuoteResponse } from '@tipme/contracts';
import { formatNaira } from './demo-amount.ts';

const SETTINGS = '/dashboard/settings';

export interface WithdrawState {
  kind: WithdrawalQuoteResponse['state'] | 'collected_elsewhere';
  canWithdraw: boolean;
  /** Keep the form in view, disabled: the balance is fine, only the check is not. */
  showForm: boolean;
  notice: {
    title: string;
    body: string;
    tone: 'neutral' | 'error';
    href?: string;
    linkLabel?: string;
  };
  /** The provider itself is checking a withdrawal already under way. */
  review: string | null;
}

const unavailable = {
  title: 'We can’t check your balance',
  body: 'We can’t check your balance with our payment partner right now. Try again in a few minutes.',
  tone: 'neutral',
} as const;

/**
 * What the Withdraw page says and allows. Money collected through another provider comes first:
 * the quote has no word for it, and it must not read as a balance we couldn't check. No quote at
 * all is treated as one we couldn't get, never as a yes.
 */
export function withdrawState(input: {
  withdrawalsAvailable: boolean;
  quote: WithdrawalQuoteResponse | null;
}): WithdrawState {
  const { quote } = input;
  const review = quote?.inReview
    ? 'Your withdrawal is being checked by the payment provider.'
    : null;
  const blocked = (
    kind: WithdrawState['kind'],
    notice: WithdrawState['notice'],
  ): WithdrawState => ({
    kind,
    canWithdraw: false,
    showForm: false,
    notice,
    review,
  });
  if (!input.withdrawalsAvailable)
    return blocked('collected_elsewhere', {
      title: 'Withdrawals aren’t available yet',
      body: 'Some of your tips were paid through a payment provider TipMe can’t pay out from yet. Your tips are safe, and your balance stays here until withdrawals open.',
      tone: 'neutral',
    });
  if (!quote || quote.state === 'provider_unavailable')
    return {
      kind: 'provider_unavailable',
      canWithdraw: false,
      showForm: true,
      notice: unavailable,
      review,
    };
  switch (quote.state) {
    case 'paused':
      if (quote.reason === 'switched_off')
        return blocked('paused', {
          title: 'Withdrawals are paused',
          body: 'Withdrawals are paused for now. Your balance is safe.',
          tone: 'neutral',
        });
      return blocked('paused', {
        title: 'Withdrawals are paused',
        body: 'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
        tone: 'neutral',
      });
    case 'setup_needed':
      return blocked('setup_needed', {
        title: 'Finish your setup',
        body: 'Finish setting up how you get paid to withdraw.',
        tone: 'neutral',
        href: quote.onboardingUrl ?? `${SETTINGS}#payments`,
        linkLabel: 'Continue setup',
      });
    case 'no_destination':
      return blocked('no_destination', {
        title: 'Add your bank account',
        body: 'Add the bank account you want to be paid to.',
        tone: 'neutral',
        href: `${SETTINGS}#get-paid`,
        linkLabel: 'Go to Get paid',
      });
    case 'destination_pending':
      return blocked('destination_pending', {
        title: 'Your bank account is being checked',
        body: 'Your bank account is being checked. You can withdraw once it’s confirmed.',
        tone: 'neutral',
      });
    case 'ready': {
      if (quote.withdrawableMinor === '0')
        return {
          kind: 'ready',
          canWithdraw: false,
          showForm: true,
          review,
          notice: {
            title: 'Nothing to withdraw right now',
            body:
              quote.ledgerMinor === '0'
                ? 'You have nothing to withdraw yet.'
                : 'Your tips are still on the way to your account with our payment partner. You can withdraw them once they arrive.',
            tone: 'neutral',
          },
        };
      const fee =
        quote.feeMinor === '0'
          ? ''
          : ` TipMe pays the ${formatNaira(quote.feeMinor)} transfer fee.`;
      return {
        kind: 'ready',
        canWithdraw: true,
        showForm: true,
        review,
        notice: {
          title: 'Ready to withdraw',
          body: `You can withdraw ${formatNaira(quote.withdrawableMinor)} to ${quote.destination.bankName} ••${quote.destination.last4}.${fee}`,
          tone: 'neutral',
        },
      };
    }
  }
}

/**
 * The most that can be withdrawn right now: the ledger balance, and no more than the quote allows.
 * Zero whenever the quote refuses (paused, setup needed, tips still settling, no quote at all).
 * Withdraw and the dashboard both use this, so neither shows more as ready than the quote allows.
 */
export function withdrawableNow(input: {
  availableMinor: string;
  withdrawalsAvailable: boolean;
  quote: WithdrawalQuoteResponse | null;
}): bigint {
  const state = withdrawState(input);
  const { quote } = input;
  if (!state.canWithdraw || quote?.state !== 'ready') return BigInt(0);
  const available = BigInt(input.availableMinor);
  const allowed = BigInt(quote.withdrawableMinor);
  return allowed < available ? allowed : available;
}
