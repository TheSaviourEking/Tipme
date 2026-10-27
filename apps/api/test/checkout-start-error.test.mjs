import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BachsApiError,
  UncertainProviderOutcomeError,
} from '@tipme/payments';
import { classifyBachsStartError } from '../dist/checkout/checkout.service.js';

test('definite Bachs rejection is safe to fail and exposes only allowlisted diagnostics', () => {
  assert.deepEqual(
    classifyBachsStartError(new BachsApiError(422, 'CAPABILITY_INACTIVE')),
    {
      outcome: 'failed',
      diagnostic: {
        error: 'BachsApiError',
        provider_http_status: 422,
        provider_code: 'CAPABILITY_INACTIVE',
      },
    },
  );
});

test('ambiguous Bachs write remains unknown without leaking its message', () => {
  assert.deepEqual(
    classifyBachsStartError(
      new UncertainProviderOutcomeError('attempt-1', 'secret detail'),
    ),
    {
      outcome: 'unknown',
      diagnostic: { error: 'UncertainProviderOutcomeError' },
    },
  );
});
