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
 * switch on, and hidden only when a You collect recipient's balance is known not to cover the price:
 * their tips reach it only once each has moved to them, so it is often empty. Anything unknown (the
 * You collect read still loading or failed, the balance unread) offers it as before, so a direct
 * recipient never depends on that read; the server refuses a payment it can't take
 * (INSUFFICIENT_BALANCE, pro-balance.ts), and the plan says why.
 *
 * The check is the ledger balance only. The server also takes the partner's figure and any
 * withdrawal hold into account; reading those here would ask the partner on every Settings visit,
 * so the server stays the backstop for that rare case.
 */
export function proPayOptions(input: {
  methods: MyPro['methods'];
  priceMinor: string;
  /** From `GET /v1/me/collect`: null until it has answered, or when it failed. */
  mode: 'direct' | 'collect' | null;
  /** The dashboard's `availableMinor`; null when unread. */
  availableMinor: string | null;
}): ProPayOption[] {
  const options: ProPayOption[] = ['checkout'];
  if (input.methods.includes('balance') && !balanceShort(input))
    options.push('balance');
  return options;
}

/** Known to be a You collect recipient whose balance is known to be less than the price. */
function balanceShort(input: {
  priceMinor: string;
  mode: 'direct' | 'collect' | null;
  availableMinor: string | null;
}): boolean {
  if (input.mode !== 'collect' || input.availableMinor === null) return false;
  return BigInt(input.availableMinor) < BigInt(input.priceMinor);
}
