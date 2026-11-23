import type { MyPro } from '@tipme/contracts';

/*
 * How a month of Pro can be paid, as the plan offers it (owner, 23 Nov 2026). Only types are
 * imported, so the rule can be tested alone. The server decides again on every payment.
 */

/**
 * `checkout`: card or bank transfer on our payment partner's page. `balance`: from the TipMe
 * balance (PRO_PAY_FROM_BALANCE). A later way to pay (from money on its way) is one more member
 * here and one more rule below.
 */
export type ProPayOption = 'checkout' | 'balance';

/**
 * The ways offered, in order. Card or bank transfer always. The balance only with the server's
 * switch on, and for a You collect recipient only when their balance covers the price: their tips
 * reach it only once each has moved to them, so it is often empty, and a payment from it would only
 * be refused. A direct recipient is offered it as before (a refusal there says why). While the mode
 * or the balance is unknown, it isn't offered: card or bank transfer always works.
 */
export function proPayOptions(input: {
  methods: MyPro['methods'];
  priceMinor: string;
  /** From `GET /v1/me/collect`: null until it has answered. */
  mode: 'direct' | 'collect' | null;
  /** The dashboard's `availableMinor`; null until it has answered. */
  availableMinor: string | null;
}): ProPayOption[] {
  const options: ProPayOption[] = ['checkout'];
  if (input.methods.includes('balance') && balanceCanPay(input))
    options.push('balance');
  return options;
}

function balanceCanPay(input: {
  priceMinor: string;
  mode: 'direct' | 'collect' | null;
  availableMinor: string | null;
}): boolean {
  if (input.mode === 'direct') return true;
  if (input.mode === null || input.availableMinor === null) return false;
  return BigInt(input.availableMinor) >= BigInt(input.priceMinor);
}
