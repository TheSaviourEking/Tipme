import { randomUUID } from 'node:crypto';
import type { MockWebhook } from '@tipme/contracts';
import type { Scenario } from '../provider.js';
import { SIGNATURE_HEADER, signWebhook } from '../signing.js';

export interface PlannedDelivery {
  body: MockWebhook;
  signed: boolean;
  delayMs: number;
}

export interface SimulatedPayment {
  reference: string;
  attemptId: string;
  amountMinor: bigint;
  currency: string;
  feeMinor: bigint;
}

const paymentEvent = (
  type: MockWebhook['type'],
  payment: SimulatedPayment,
  overrides: { id?: string; amountMinor?: bigint } = {},
): MockWebhook => ({
  id: overrides.id ?? `evt_${randomUUID()}`,
  type,
  data: {
    reference: payment.reference,
    attemptId: payment.attemptId,
    amountMinor: (overrides.amountMinor ?? payment.amountMinor).toString(),
    currency: payment.currency,
    feeMinor: payment.feeMinor.toString(),
  },
});

const step = (
  body: MockWebhook,
  delayMs = 0,
  signed = true,
): PlannedDelivery => ({ body, signed, delayMs });

/** The webhook sequence each agreed payment scenario produces (see the PR-006 design). */
export function planScenario(
  scenario: Scenario,
  payment: SimulatedPayment,
): PlannedDelivery[] {
  switch (scenario) {
    case 'succeed':
      return [
        step(paymentEvent('payment.pending', payment)),
        step(paymentEvent('payment.succeeded', payment)),
      ];
    case 'decline':
      return [step(paymentEvent('payment.failed', payment))];
    case 'pending-then-succeed':
      return [
        step(paymentEvent('payment.pending', payment)),
        step(paymentEvent('payment.succeeded', payment), 500),
      ];
    case 'duplicate': {
      const id = `evt_${randomUUID()}`;
      return [
        step(paymentEvent('payment.succeeded', payment, { id })),
        step(paymentEvent('payment.succeeded', payment, { id })),
      ];
    }
    case 'out-of-order':
      return [
        step(paymentEvent('payment.succeeded', payment)),
        step(paymentEvent('payment.pending', payment)),
      ];
    case 'wrong-amount':
      return [
        step(
          paymentEvent('payment.succeeded', payment, {
            amountMinor: payment.amountMinor - 1n,
          }),
        ),
      ];
    case 'forged':
      return [step(paymentEvent('payment.succeeded', payment), 0, false)];
    case 'no-reply':
    case 'payout-paid':
    case 'payout-failed':
      return [];
  }
}

export interface SimulatedPayout {
  reference: string;
  payoutId: string;
  amountMinor: bigint;
  currency: string;
}

/** Payout scenarios: processing, then paid or failed. */
export function planPayoutScenario(
  scenario: 'payout-paid' | 'payout-failed',
  payout: SimulatedPayout,
): PlannedDelivery[] {
  const event = (type: MockWebhook['type']): MockWebhook => ({
    id: `evt_${randomUUID()}`,
    type,
    data: {
      reference: payout.reference,
      payoutId: payout.payoutId,
      amountMinor: payout.amountMinor.toString(),
      currency: payout.currency,
      feeMinor: '0',
    },
  });
  return [
    step(event('payout.processing')),
    step(event(scenario === 'payout-paid' ? 'payout.paid' : 'payout.failed')),
  ];
}

/** Delivers each planned webhook; the exact string sent is the string signed. Returns HTTP statuses. */
export async function runScenario(options: {
  plan: PlannedDelivery[];
  webhookUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<number[]> {
  const send = options.fetchImpl ?? fetch;
  const statuses: number[] = [];
  for (const delivery of options.plan) {
    if (delivery.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, delivery.delayMs));
    const raw = JSON.stringify(delivery.body);
    const signature = delivery.signed
      ? signWebhook(raw, options.secret, new Date())
      : signWebhook(raw, 'forged-secret-not-known-to-tipme-000000', new Date());
    const response = await send(options.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signature,
      },
      body: raw,
    });
    await response.arrayBuffer();
    statuses.push(response.status);
  }
  return statuses;
}
