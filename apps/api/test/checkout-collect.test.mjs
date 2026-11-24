import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BachsRequestNotSentError,
  PlatformCheckoutUnavailableError,
  UncertainProviderOutcomeError,
} from '@tipme/payments';
import { classifyBachsStartError } from '../dist/checkout/checkout.service.js';

// You collect (plan Task 6): a collect checkout start is classified like a direct one. Only a
// definite refusal fails the tip; anything that may have reached the partner stays unknown.

test('a collect start refused because TipMe’s own account is not activated fails, with only its code', () => {
  assert.deepEqual(
    classifyBachsStartError(
      new PlatformCheckoutUnavailableError('ACCOUNT_NOT_ACTIVATED'),
    ),
    {
      outcome: 'failed',
      diagnostic: {
        error: 'PlatformCheckoutUnavailableError',
        provider_code: 'ACCOUNT_NOT_ACTIVATED',
      },
    },
  );
});

test('a collect start that was never sent fails; one that timed out stays unknown', () => {
  assert.equal(
    classifyBachsStartError(new BachsRequestNotSentError('bad input')).outcome,
    'failed',
  );
  assert.equal(
    classifyBachsStartError(
      new UncertainProviderOutcomeError('attempt-1', 'no response'),
    ).outcome,
    'unknown',
  );
});
