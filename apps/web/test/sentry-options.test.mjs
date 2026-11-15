import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEvent } from '../src/lib/sentry-scrub.ts';
import { sentryOptions } from '../src/lib/sentry-options.ts';

// @sentry/nextjs 11 streams spans by default and then ignores beforeSendTransaction, so traces
// would leave unscrubbed (ADR-0005). The transaction scrubber only runs with the static lifecycle.
test('traces use the static lifecycle so beforeSendTransaction scrubs them', () => {
  const options = sentryOptions('https://key@example.ingest.sentry.io/1');
  assert.equal(options.traceLifecycle, 'static');
  assert.equal(options.beforeSendTransaction, scrubEvent);
  assert.equal(options.beforeSend, scrubEvent);
});

test('the transaction scrubber strips the query from the request URL', () => {
  const options = sentryOptions(undefined);
  const out = options.beforeSendTransaction({
    request: { url: 'https://tipme.test/tip/1?token=abc#x' },
  });
  assert.equal(out.request.url, 'https://tipme.test/tip/1');
});
