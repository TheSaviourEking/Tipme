import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BachsApiError,
  BachsRequestNotSentError,
  BachsTransportError,
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

test('an ambiguous Bachs write logs its cause and Bachs status, still unknown', () => {
  assert.deepEqual(
    classifyBachsStartError(
      new UncertainProviderOutcomeError('attempt-1', 'secret detail', {
        cause: 'http_error',
        httpStatus: 503,
        providerCode: 'TEMPORARILY_UNAVAILABLE',
      }),
    ),
    {
      outcome: 'unknown',
      diagnostic: {
        error: 'UncertainProviderOutcomeError',
        reason: 'http_error',
        provider_http_status: 503,
        provider_code: 'TEMPORARILY_UNAVAILABLE',
      },
    },
  );
});

test('a checkout that never reached Bachs is refused; a lost or failed reply stays unknown', () => {
  assert.deepEqual(
    classifyBachsStartError(new BachsRequestNotSentError('bad return URL')),
    { outcome: 'failed', diagnostic: { error: 'BachsRequestNotSentError' } },
  );
  // Sent, but the answer was lost or unreadable: Bachs may have created the checkout.
  assert.equal(
    classifyBachsStartError(new BachsTransportError()).outcome,
    'unknown',
  );
  assert.equal(
    classifyBachsStartError(
      new UncertainProviderOutcomeError('attempt-1', 'no reply'),
    ).outcome,
    'unknown',
  );
});
