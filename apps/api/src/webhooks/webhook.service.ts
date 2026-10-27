import { Inject, Injectable } from '@nestjs/common';
import type { MockWebhook } from '@tipme/contracts';
import type { NormalizedProviderEvent } from '@tipme/payments';
import { z } from 'zod';
import {
  findBachsAttemptByOperationReference,
  findBachsAttemptByReference,
  findAttemptByReference,
  findPayoutByReference,
  OperationError,
  recordPayoutOutcome,
  recordProviderEvent,
  recordUnmatchedEvent,
} from '@tipme/database';
import { DatabaseProvider } from '../infra/database.js';

const PROVIDER = 'mock';

/**
 * Applies a verified provider message through the PR-005 operations. Matching is by the provider's
 * reference (recorded when the payment or payout started), never by an ID the message claims.
 */
@Injectable()
export class WebhookService {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async apply(event: MockWebhook): Promise<string> {
    const { db } = this.database;
    const { reference } = event.data;
    if (event.type.startsWith('payment.')) {
      const attemptId = await findAttemptByReference(db, PROVIDER, reference);
      if (!attemptId) return this.unmatched(event, 'unknown_attempt');
      const result = await recordProviderEvent(db, {
        provider: PROVIDER,
        providerEventId: event.id,
        eventType: event.type as
          'payment.pending' | 'payment.succeeded' | 'payment.failed',
        attemptId,
        providerReference: reference,
        amountMinor: BigInt(event.data.amountMinor),
        currency: event.data.currency,
        providerFeeMinor: BigInt(event.data.feeMinor),
        signatureVerified: true,
        payload: event,
      });
      return result.outcome;
    }
    const payoutId = await findPayoutByReference(db, PROVIDER, reference);
    if (!payoutId) return this.unmatched(event, 'unknown_payout');
    const result = await recordPayoutOutcome(db, {
      payoutId,
      provider: PROVIDER,
      providerEventId: event.id,
      providerReference: reference,
      outcome: event.type.slice('payout.'.length) as
        'processing' | 'paid' | 'failed',
      signatureVerified: true,
      payload: event,
    });
    return result.outcome;
  }

  async applyBachs(event: NormalizedProviderEvent): Promise<string> {
    if (event.kind === 'ignored') return 'ignored';
    const { accountReference, operationReference, providerReference } = event;
    if (!accountReference || !providerReference)
      return this.unmatchedBachs(event);

    let attemptId: string | null = null;
    if (operationReference) {
      if (!z.uuid().safeParse(operationReference).success)
        return this.unmatchedBachs(event);
      attemptId = await findBachsAttemptByOperationReference(this.database.db, {
        attemptId: operationReference,
        accountReference,
      });
    } else {
      attemptId = await findBachsAttemptByReference(this.database.db, {
        providerReference,
        accountReference,
      });
    }
    if (!attemptId) return this.unmatchedBachs(event);

    try {
      const result = await recordProviderEvent(this.database.db, {
        provider: 'bachs',
        providerEventId: event.eventId,
        eventType: 'payment.pending',
        attemptId,
        providerReference,
        ...(event.amountMinor === undefined
          ? {}
          : { amountMinor: event.amountMinor }),
        ...(event.currency === undefined ? {} : { currency: event.currency }),
        ...(event.feeMinor === undefined
          ? {}
          : { providerFeeMinor: event.feeMinor }),
        signatureVerified: true,
        payload: event,
      });
      return result.outcome;
    } catch (error) {
      if (error instanceof OperationError && error.code === 'INVALID_INPUT') {
        return this.unmatchedBachs(event);
      }
      throw error;
    }
  }

  private async unmatched(
    event: MockWebhook,
    reason: 'unknown_attempt' | 'unknown_payout',
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider: PROVIDER,
      providerEventId: event.id,
      eventType: event.type,
      payload: event,
      reason,
    });
    return 'unmatched';
  }

  private async unmatchedBachs(
    event: NormalizedProviderEvent,
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider: 'bachs',
      providerEventId: event.eventId,
      eventType: event.eventType,
      payload: event,
      reason: 'unknown_attempt',
    });
    return 'unmatched';
  }
}
