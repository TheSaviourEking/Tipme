import type { WithdrawalQuoteResponse } from '@tipme/contracts';
import { belowWithdrawalMinimum } from '@tipme/domain';
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
        title: 'Set up the business’s payout account',
        body: 'The business needs its own payout account with our payment partner before it can withdraw. The balance stays here and is safe.',
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
      // The business pays the transfer fee from the amount (owner, 12 Nov 2026): a balance not
      // more than the fee would send nothing, so it can't be withdrawn, and the page says why.
      const userPays = quote.feePaidBy === 'user' && quote.feeMinor !== '0';
      if (userPays && withdrawable <= BigInt(quote.feeMinor))
        return no({
          title: 'Nothing to withdraw right now',
          body: `The business’s ${formatNaira(quote.withdrawableMinor)} isn’t more than the ${formatNaira(quote.feeMinor)} transfer fee, so it can’t be withdrawn yet. It stays in the business’s balance.`,
        });
      return {
        canWithdraw: true,
        withdrawableMinor: withdrawable,
        notice: {
          title: 'Ready to withdraw',
          body:
            `You can withdraw ${formatNaira(quote.withdrawableMinor)} to ${quote.destination.bankName} ••${quote.destination.last4}.` +
            (userPays
              ? ` The ${formatNaira(quote.feeMinor)} transfer fee comes off the amount you withdraw.`
              : ''),
        },
      };
    }
  }
}

/**
 * What a business may send (owner, 12 and 14 Nov 2026): the shared withdrawal rule (at least the
 * minimum tip, or everything it can withdraw now; `belowWithdrawalMinimum`), never more, and always
 * more than the fee it pays from the amount (`feeMinor`; zero when TipMe's unused top-up pays it),
 * so something arrives.
 */
export function businessCanSend(
  amountMinor: bigint,
  withdrawableMinor: bigint,
  feeMinor: bigint,
): boolean {
  return (
    amountMinor > BigInt(0) &&
    amountMinor > feeMinor &&
    amountMinor <= withdrawableMinor &&
    !belowWithdrawalMinimum(amountMinor, withdrawableMinor)
  );
}
