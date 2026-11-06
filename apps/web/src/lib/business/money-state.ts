import type { WithdrawalQuoteResponse } from '@tipme/contracts';
import { formatNaira } from '../demo-amount.ts';

export interface BusinessMoneyState {
  canWithdraw: boolean;
  /** The most the owner can ask for now: what the quote allows, never more; zero when refused. */
  withdrawableMinor: bigint;
  notice: { title: string; body: string; href?: string; linkLabel?: string };
}

const BANK = '#business-bank';

/**
 * Business release 2, PR R2-B: what a business's Money section says and allows, from its own
 * withdrawal quote (the same states as a person's). No quote at all is one we couldn't get, never
 * a yes. Copy names "our payment partner", never the provider.
 */
export function businessMoneyState(
  quote: WithdrawalQuoteResponse | null,
): BusinessMoneyState {
  const no = (notice: BusinessMoneyState['notice']): BusinessMoneyState => ({
    canWithdraw: false,
    withdrawableMinor: BigInt(0),
    notice,
  });
  if (!quote || quote.state === 'provider_unavailable')
    return no({
      title: 'We can’t check the balance',
      body: 'We can’t check the business’s balance with our payment partner right now. Try again in a few minutes.',
    });
  switch (quote.state) {
    case 'paused':
      if (quote.reason === 'switched_off')
        return no({
          title: 'Withdrawals are paused',
          body: 'Withdrawals are paused for now. The business’s balance is safe.',
        });
      if (quote.reason === 'reversal')
        return no({
          title: 'Withdrawals are paused',
          body: 'A refund or chargeback took back more than the business’s balance held. Withdrawals start again once new tips bring it back above zero.',
        });
      return no({
        title: 'Withdrawals are paused',
        body: 'Withdrawals are paused while support checks an account. Questions: support@usetipme.xyz',
      });
    case 'setup_needed':
      return no({
        title: 'Not available yet',
        body: 'Withdrawals for a business aren’t available with our payment partner yet. The balance stays here and is safe.',
      });
    case 'no_destination':
      return no({
        title: 'Add the business’s bank account',
        body: 'Add the bank account the business wants to be paid to.',
        href: BANK,
        linkLabel: 'Add a bank account',
      });
    case 'destination_pending':
      return no({
        title: 'The bank account is being checked',
        body: 'The business’s bank account is being checked. You can withdraw once it’s confirmed.',
      });
    case 'ready': {
      const withdrawable = BigInt(quote.withdrawableMinor);
      if (withdrawable === BigInt(0))
        return no({
          title: 'Nothing to withdraw right now',
          body:
            quote.ledgerMinor === '0'
              ? 'The business has nothing to withdraw yet.'
              : 'The business’s share is still on its way to our payment partner. You can withdraw it once it arrives.',
        });
      return {
        canWithdraw: true,
        withdrawableMinor: withdrawable,
        notice: {
          title: 'Ready to withdraw',
          body: `You can withdraw ${formatNaira(quote.withdrawableMinor)} to ${quote.destination.bankName} ••${quote.destination.last4}.`,
        },
      };
    }
  }
}
