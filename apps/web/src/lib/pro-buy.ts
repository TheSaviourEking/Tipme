'use client';
import type {
  MyPro,
  ProAutoRenew,
  ProPurchase,
  PublicProPrice,
} from '@tipme/contracts';
import { proPrice } from './api-client';
import { naira } from './money';
import { newUuid } from './random-id';
import { apiFetch } from './session-client';

/**
 * Paid Pro in the browser (ADR-0015). The server owns the price, every status and the plan; this
 * only asks, and sends the person to our payment partner's checkout. A return from the checkout
 * proves nothing: Settings reads the purchase back until the partner's confirmation is recorded.
 */

export const ASK_FOR_PRO = 'mailto:support@usetipme.xyz?subject=TipMe%20Pro';

/** Where Pro is managed and where the checkout returns. */
export const PLAN_HREF = '/dashboard/settings#plan';

export type PriceState =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error' }
  | { kind: 'price'; price: PublicProPrice };

export async function readPrice(): Promise<PriceState> {
  const result = await proPrice();
  if (result.ok) return { kind: 'price', price: result.data };
  if (result.status === 404) return { kind: 'none' };
  return { kind: 'error' };
}

export const readMyPro = () => apiFetch<MyPro>('/v1/me/pro');

export const readPurchase = (purchaseId: string) =>
  apiFetch<ProPurchase>(
    `/v1/me/pro/purchases/${encodeURIComponent(purchaseId)}`,
  );

// The purchase this tab sent to the checkout, so Settings can follow it on the way back. Only an
// id: no amount, no status. Storage can be blocked; then Settings shows the open purchase instead.
const RETURN_KEY = 'tipme:pro-purchase';

export function rememberPurchase(purchaseId: string): void {
  try {
    window.sessionStorage.setItem(RETURN_KEY, purchaseId);
  } catch {
    // Blocked storage: nothing to follow on return, which is safe.
  }
}

export function returningPurchase(): string | null {
  try {
    return window.sessionStorage.getItem(RETURN_KEY);
  } catch {
    return null;
  }
}

export function forgetPurchase(): void {
  try {
    window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Nothing stored.
  }
}

export type StartResult =
  { ok: true } | { ok: false; message: string; priceChanged?: boolean };

const REFUSALS: Record<string, string> = {
  PRO_BILLING_OFF: 'Buying Pro isn’t open yet.',
  PRO_ALREADY_RENEWED:
    'Your next month is already paid. You can pay for another once it starts.',
  PRO_CHECKOUT_UNAVAILABLE:
    'Our payment partner can’t take this payment right now. Please try again in a few minutes.',
  NETWORK: 'We couldn’t reach TipMe. Check your connection and try again.',
  PRO_AUTO_RENEW_NEEDS_EMAIL:
    'To renew automatically, add an email address to your account first. Or untick it and pay as usual.',
};

const INSTEAD = 'You can pay by card or bank transfer instead.';

/** Refusals of a payment from the balance (PRO_PAY_FROM_BALANCE). Nothing was taken in any. */
const BALANCE_REFUSALS: Record<string, (amountMinor: string) => string> = {
  INSUFFICIENT_BALANCE: (amount) =>
    `Your balance is less than ${naira(amount)}. ${INSTEAD}`,
  BALANCE_BELOW_ZERO: () =>
    `Your balance is below zero, so it can’t pay for Pro. ${INSTEAD}`,
  WITHDRAWALS_PAUSED: () => `Your balance can’t be used right now. ${INSTEAD}`,
  PRO_BALANCE_REFUSED: () =>
    `Our payment partner couldn’t take this from your balance. Nothing was taken. ${INSTEAD}`,
};

const PRICE_CHANGED = {
  ok: false,
  priceChanged: true,
  message: 'The price of Pro has changed. Check the new price and try again.',
} as const;

/**
 * Opens a purchase at the price the person saw and goes to the checkout. A purchase already open
 * (another tab, a back button) is continued rather than doubled.
 */
export async function startPurchase(
  expectedAmountMinor: string,
  { autoRenew = false }: { autoRenew?: boolean } = {},
): Promise<StartResult> {
  const result = await apiFetch<ProPurchase>('/v1/me/pro/purchases', {
    method: 'POST',
    // autoRenew only when ticked (PRO_AUTO_RENEW): the server refuses it with the flag off.
    body: autoRenew
      ? { expectedAmountMinor, autoRenew }
      : { expectedAmountMinor },
    headers: { 'idempotency-key': newUuid() },
  });
  if (result.ok) return go(result.data);
  if (result.code === 'PRO_PURCHASE_OPEN') {
    const mine = await readMyPro();
    if (mine.ok && mine.data.openPurchase) return go(mine.data.openPurchase);
  }
  if (result.code === 'PRO_PRICE_CHANGED') return PRICE_CHANGED;
  return {
    ok: false,
    message:
      REFUSALS[result.code] ??
      'Something went wrong on our side. Please try again.',
  };
}

function go(purchase: ProPurchase): StartResult {
  if (!purchase.checkoutUrl)
    return {
      ok: false,
      message: 'This payment can’t be continued. Please start again.',
    };
  rememberPurchase(purchase.purchaseId);
  window.location.assign(purchase.checkoutUrl);
  return { ok: true };
}

export type BalanceResult =
  | { ok: true; purchase: ProPurchase }
  | { ok: false; message: string; priceChanged?: boolean };

/**
 * Pays one month from the TipMe balance (PRO_PAY_FROM_BALANCE). No checkout: the answer is usually
 * PAID at once; UNKNOWN or COLLECTING means the partner hasn't answered, and Settings reads it back.
 */
export async function payFromBalance(
  expectedAmountMinor: string,
): Promise<BalanceResult> {
  const result = await apiFetch<ProPurchase>('/v1/me/pro/purchases', {
    method: 'POST',
    body: { expectedAmountMinor, method: 'balance' },
    headers: { 'idempotency-key': newUuid() },
  });
  if (result.ok) return { ok: true, purchase: result.data };
  if (result.code === 'PRO_PRICE_CHANGED') return PRICE_CHANGED;
  const refusal = BALANCE_REFUSALS[result.code];
  return {
    ok: false,
    message: refusal
      ? refusal(expectedAmountMinor)
      : (REFUSALS[result.code] ??
        'Something went wrong on our side. Please try again.'),
  };
}

/** "Turn off auto-renew": always allowed, whatever the flag; forgets the saved card. */
export const turnOffAutoRenew = () =>
  apiFetch<ProAutoRenew>('/v1/me/pro/auto-renew/off', { method: 'POST' });

/** Grace: the paid month has ended and the three days to pay have not. */
export function inGrace(current: MyPro['current'], now = Date.now()): boolean {
  if (!current) return false;
  return (
    Date.parse(current.endsAt) <= now && now < Date.parse(current.graceEndsAt)
  );
}
