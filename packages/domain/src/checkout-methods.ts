import { basisPointsOf } from './fees.js';

export type CheckoutMethod = 'card' | 'bank_transfer';

/** What a card payment costs TipMe: percentage, fixed part, and a safety margin (all bigint). */
export interface CardCost {
  rateBps: bigint;
  fixedMinor: bigint;
  marginMinor: bigint;
}

export const DEFAULT_CARD_COST: CardCost = {
  rateBps: 200n,
  fixedMinor: 4500n,
  marginMinor: 1500n,
};

/**
 * Bank transfer is always offered. Card is offered too only when TipMe's share
 * covers the card cost: share × 10000 ≥ amount × rateBps + (fixed + margin) × 10000,
 * and share > 0. Integer arithmetic only. Bank transfer comes first.
 */
export function checkoutMethodsFor(input: {
  amountMinor: bigint;
  tipmeShareMinor: bigint;
  card: CardCost;
}): CheckoutMethod[] {
  const { amountMinor, tipmeShareMinor, card } = input;
  const covers =
    tipmeShareMinor > 0n &&
    tipmeShareMinor * 10000n >=
      amountMinor * card.rateBps +
        (card.fixedMinor + card.marginMinor) * 10000n;
  return covers ? ['bank_transfer', 'card'] : ['bank_transfer'];
}

/**
 * For staff screens: the smallest tip at which a plan rate offers card,
 * ceil((fixed + margin) × 10000 / (rateBps − card.rateBps)); null when the
 * plan rate never exceeds the card rate.
 */
export function cardFromMinor(rateBps: bigint, card: CardCost): bigint | null {
  const spread = rateBps - card.rateBps;
  if (spread <= 0n) return null;
  const numerator = (card.fixedMinor + card.marginMinor) * 10000n;
  return (numerator + spread - 1n) / spread;
}

/**
 * For staff screens: the smallest whole-naira tip from which a checkout on this plan rate offers
 * card at that amount and every whole naira above it; null when the rate never exceeds the card
 * rate. `cardFromMinor` assumes an unrounded share, but a quote rounds TipMe's share half up to the
 * kobo (`basisPointsOf`), so near the line card can come and go by a kobo either way. The rounded
 * share is at least amount × rate − 4999 (in ten-thousandths of a kobo), so from the first whole
 * naira where amount × (rate − card rate) ≥ (fixed + margin) × 10000 + 4999 every amount is
 * covered. From there this steps down one naira at a time, pricing the share as the quote does,
 * while the naira below still offers card. About 5000 / (rate − card rate) / 100 + 1 steps.
 */
export function cardOfferedFromNaira(
  rateBps: bigint,
  card: CardCost,
): bigint | null {
  const spread = rateBps - card.rateBps;
  if (spread <= 0n) return null;
  const sure =
    ((card.fixedMinor + card.marginMinor) * 10000n + 4999n + spread - 1n) /
    spread;
  const offers = (amount: bigint) =>
    amount > 0n &&
    checkoutMethodsFor({
      amountMinor: amount,
      tipmeShareMinor: basisPointsOf(amount, rateBps),
      card,
    }).includes('card');
  let amount = ((sure + 99n) / 100n) * 100n;
  while (offers(amount - 100n)) amount -= 100n;
  return amount;
}
