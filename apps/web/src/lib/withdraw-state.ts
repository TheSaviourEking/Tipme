import type { WithdrawalQuoteResponse } from '@tipme/contracts';
import { CURRENT_FEE_POLICY } from '@tipme/domain';
import type { LampTone } from '@tipme/ui';
import { formatNaira } from './demo-amount.ts';

const SETTINGS = '/dashboard/settings';

export interface WithdrawState {
  kind:
    WithdrawalQuoteResponse['state'] | 'collected_elsewhere' | 'needs_check';
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
  /** Our payment partner is checking a withdrawal already under way. */
  review: string | null;
  /**
   * Where the notice's words go (WithdrawRedesign): on the instrument (one line, no box), in a
   * slip, or a standing warning.
   */
  place: 'instrument' | 'slip' | 'warning';
  /** The ink stamp on the slip, when there is one. */
  stamp?: string;
}

const NOTHING_NOW = 'Nothing to withdraw right now';

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
  /** A live update changed something only a full quote can size (quote-merge.ts). */
  needsCheck?: boolean;
}): WithdrawState {
  const { quote } = input;
  // The same words as an open row in the ledger (WithdrawRedesign, "Copy to settle").
  const review = quote?.inReview ? 'Our payment partner is checking it.' : null;
  const blocked = (
    kind: WithdrawState['kind'],
    notice: WithdrawState['notice'],
    place: WithdrawState['place'] = 'instrument',
  ): WithdrawState => ({
    kind,
    canWithdraw: false,
    showForm: false,
    notice,
    review,
    place,
  });
  if (!input.withdrawalsAvailable)
    return blocked('collected_elsewhere', {
      title: 'Withdrawals aren’t available yet',
      body: 'Some of your tips were paid through a payment provider TipMe can’t pay out from yet. Your tips are safe, and your balance stays here until withdrawals open.',
      tone: 'neutral',
    });
  if (input.needsCheck)
    return {
      kind: 'needs_check',
      canWithdraw: false,
      showForm: true,
      notice: {
        title: 'Check what you can withdraw',
        body: 'Something changed since this page loaded. Check again to see what you can withdraw now.',
        tone: 'neutral',
      },
      review,
      place: 'instrument',
    };
  if (!quote || quote.state === 'provider_unavailable')
    return {
      kind: 'provider_unavailable',
      canWithdraw: false,
      showForm: true,
      notice: unavailable,
      review,
      place: 'instrument',
    };
  switch (quote.state) {
    case 'paused':
      if (quote.reason === 'switched_off')
        return blocked(
          'paused',
          {
            title: 'Withdrawals are paused',
            body: 'Withdrawals are paused for now. Your balance is safe.',
            tone: 'neutral',
          },
          'warning',
        );
      return blocked(
        'paused',
        {
          title: 'Withdrawals are paused',
          body: 'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
          tone: 'neutral',
        },
        'warning',
      );
    case 'setup_needed':
      return blocked('setup_needed', {
        title: 'Finish your setup',
        body: 'Finish setting up how you get paid to withdraw.',
        tone: 'neutral',
        href: quote.onboardingUrl ?? `${SETTINGS}#payments`,
        linkLabel: 'Continue setup',
      });
    case 'no_destination':
      return {
        ...blocked(
          'no_destination',
          {
            title: 'Add your bank account',
            body: 'Add the bank account you want to be paid to.',
            tone: 'neutral',
            href: `${SETTINGS}#get-paid`,
            linkLabel: 'Go to Get paid',
          },
          'slip',
        ),
        stamp: 'Needs\na bank',
      };
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
          place: 'instrument',
          notice: {
            title: NOTHING_NOW,
            body:
              quote.ledgerMinor === '0'
                ? 'You have nothing to withdraw yet.'
                : 'Your tips are still on the way to your account with our payment partner. You can withdraw them once they arrive.',
            tone: 'neutral',
          },
        };
      const fee = withdrawFee(quote);
      return {
        kind: 'ready',
        canWithdraw: true,
        showForm: true,
        review,
        place: 'instrument',
        notice: {
          title: 'Ready to withdraw',
          body: `You can withdraw ${formatNaira(quote.withdrawableMinor)} to ${quote.destination.bankName} ••${quote.destination.last4}.${fee ? ` ${fee}` : ''}`,
          tone: 'neutral',
        },
      };
    }
  }
}

/**
 * Who pays the transfer fee, when the quote has one: TipMe does (buildPayoutFeePosting books it as
 * TipMe's expense), so it is never taken from the recipient. Null for no fee or no ready quote.
 */
export function withdrawFee(
  quote: WithdrawalQuoteResponse | null,
): string | null {
  if (quote?.state !== 'ready' || quote.feeMinor === '0') return null;
  return `TipMe pays the ${formatNaira(quote.feeMinor)} transfer fee.`;
}

/**
 * The one lamp line on the instrument (WithdrawRedesign §1–2), only from the state and what can go
 * now (withdrawableNow()). It states a figure or a condition, never a money reassurance.
 */
export function withdrawLamp(
  state: WithdrawState,
  withdrawableMinor: bigint,
): { tone: LampTone; text: string } {
  switch (state.kind) {
    case 'ready':
      return withdrawableMinor > BigInt(0)
        ? {
            tone: 'purple',
            text: `Ready to withdraw ${formatNaira(withdrawableMinor)}`,
          }
        : { tone: 'off', text: NOTHING_NOW };
    case 'provider_unavailable':
    case 'destination_pending':
    // A live update changed something only a full quote can size: the person checks again.
    case 'needs_check':
      return { tone: 'amber', text: state.notice.title };
    case 'no_destination':
      return { tone: 'off', text: 'Add a bank to withdraw' };
    case 'paused':
      return { tone: 'amber', text: 'Paused for now' };
    case 'setup_needed':
    case 'collected_elsewhere':
      return { tone: 'off', text: state.notice.title };
  }
}

/** Refused before anything was recorded; the page's own state says why, so no message is added. */
const SHOWN_BY_PAGE: ReadonlySet<string> = new Set([
  'WITHDRAWALS_PAUSED',
  'WITHDRAWALS_SWITCHED_OFF',
  'PAYOUT_SETUP_NEEDED',
  'PAYOUT_DESTINATION_NEEDED',
  'PAYOUT_PROVIDER_UNAVAILABLE',
  'WITHDRAWAL_UNAVAILABLE',
]);

/**
 * What the Withdraw page does with a refused request. The amount on screen can be a few seconds
 * old, because the partner's figures behind a quote are cached briefly; the withdrawal itself is
 * checked fresh. So a refusal about the amount reloads the figures, and the message stays beside
 * the new amount instead of a stale one.
 */
export function withdrawRefusal(code: string | undefined): {
  message: string | null;
  reload: boolean;
} {
  if (code !== undefined && SHOWN_BY_PAGE.has(code))
    return { message: null, reload: true };
  if (code === 'INSUFFICIENT_BALANCE')
    return {
      message: 'That is more than your available balance.',
      reload: true,
    };
  if (code === 'WITHDRAWAL_TOO_SMALL')
    return {
      message: `The smallest withdrawal is ${formatNaira(CURRENT_FEE_POLICY.minWithdrawalMinor)}.`,
      reload: true,
    };
  if (code === 'IDEMPOTENCY_CONFLICT')
    return {
      message:
        'This withdrawal may already be on its way. Check your dashboard before asking again.',
      reload: false,
    };
  // Any other failure may have followed a request that arrived. The key stays, so the same amount
  // again can't withdraw twice, but it must not read as nothing happened.
  return {
    message:
      'We couldn’t confirm your withdrawal. Check your dashboard before trying again.',
    reload: false,
  };
}

/**
 * The refusals whose words go to a "not confirmed" slip instead of the amount field: they may have
 * followed a request that arrived, so they say nothing about money or the balance. Null for the
 * refusals the field or the page itself explains. The words are withdrawRefusal's, split at the
 * full stop.
 */
export function withdrawUnsure(
  code: string | undefined,
): { title: string; body: string } | null {
  if (code === 'IDEMPOTENCY_CONFLICT')
    return {
      title: 'This withdrawal may already be on its way',
      body: 'Check your dashboard before asking again.',
    };
  if (
    (code !== undefined && SHOWN_BY_PAGE.has(code)) ||
    code === 'INSUFFICIENT_BALANCE' ||
    code === 'WITHDRAWAL_TOO_SMALL'
  )
    return null;
  return {
    title: 'We couldn’t confirm your withdrawal',
    body: 'Check your dashboard before trying again.',
  };
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
  needsCheck?: boolean;
}): bigint {
  const state = withdrawState(input);
  const { quote } = input;
  if (!state.canWithdraw || quote?.state !== 'ready') return BigInt(0);
  const available = BigInt(input.availableMinor);
  const allowed = BigInt(quote.withdrawableMinor);
  return allowed < available ? allowed : available;
}

/** What the field says for an amount below the smallest withdrawal (WithdrawRedesign §2). */
export const TOO_SMALL = `Too small. The smallest withdrawal is ${formatNaira(CURRENT_FEE_POLICY.minWithdrawalMinor)}, or your whole balance if it’s less.`;

/**
 * The amount is below the smallest withdrawal and isn't the whole of what can go now
 * (CURRENT_FEE_POLICY): the server would refuse it, so the field says so before anything is sent.
 */
export function belowMinimum(
  chosen: bigint | null,
  withdrawable: bigint,
): boolean {
  return (
    chosen !== null &&
    chosen > BigInt(0) &&
    chosen < CURRENT_FEE_POLICY.minWithdrawalMinor &&
    chosen !== withdrawable
  );
}
