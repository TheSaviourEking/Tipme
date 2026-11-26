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
