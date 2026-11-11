'use client';
import type { MyPro, ProPurchase, PublicProPrice } from '@tipme/contracts';
import { proPrice } from './api-client';
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
};

/**
 * Opens a purchase at the price the person saw and goes to the checkout. A purchase already open
 * (another tab, a back button) is continued rather than doubled.
 */
export async function startPurchase(
  expectedAmountMinor: string,
): Promise<StartResult> {
  const result = await apiFetch<ProPurchase>('/v1/me/pro/purchases', {
    method: 'POST',
    body: { expectedAmountMinor },
    headers: { 'idempotency-key': newUuid() },
  });
  if (result.ok) return go(result.data);
  if (result.code === 'PRO_PURCHASE_OPEN') {
    const mine = await readMyPro();
    if (mine.ok && mine.data.openPurchase) return go(mine.data.openPurchase);
  }
  if (result.code === 'PRO_PRICE_CHANGED')
    return {
      ok: false,
      priceChanged: true,
      message:
        'The price of Pro has changed. Check the new price and try again.',
    };
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

/** Grace: the paid month has ended and the three days to pay have not. */
export function inGrace(current: MyPro['current'], now = Date.now()): boolean {
  if (!current) return false;
  return (
    Date.parse(current.endsAt) <= now && now < Date.parse(current.graceEndsAt)
  );
}
