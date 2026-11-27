import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEvent } from '../src/lib/sentry-scrub.ts';
import { sentryOptions } from '../src/lib/sentry-options.ts';

// Stands in for the SDK's own marker on static-lifecycle span callbacks.
const sdk = {
  withStaticSpan: (callback) =>
    Object.assign(callback, { wrappedForStatic: true }),
};

// @sentry/nextjs 11 streams spans by default and then ignores beforeSendTransaction, so traces
// would leave unscrubbed (ADR-0005). The transaction scrubber only runs with the static lifecycle.
test('traces use the static lifecycle so beforeSendTransaction scrubs them', () => {
  const options = sentryOptions('https://key@example.ingest.sentry.io/1', sdk);
  assert.equal(options.traceLifecycle, 'static');
  assert.equal(options.beforeSendTransaction, scrubEvent);
  assert.equal(options.beforeSend, scrubEvent);
});

test('the transaction scrubber strips the query from the request URL', () => {
  const options = sentryOptions(undefined, sdk);
  const out = options.beforeSendTransaction({
    request: { url: 'https://tipme.test/tip/1?token=abc#x' },
  });
  assert.equal(out.request.url, 'https://tipme.test/tip/1');
});

// Off Vercel (26 Nov 2026): the environment is NEXT_PUBLIC_SENTRY_ENVIRONMENT, else NODE_ENV.
test('the environment never comes from a Vercel variable', () => {
  const saved = {
    env: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    vercel: process.env.NEXT_PUBLIC_VERCEL_ENV,
  };
  try {
    delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
    process.env.NEXT_PUBLIC_VERCEL_ENV = 'preview';
    assert.equal(
      sentryOptions(undefined, sdk).environment,
      process.env.NODE_ENV,
    );
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = 'staging';
    assert.equal(sentryOptions(undefined, sdk).environment, 'staging');
  } finally {
    for (const [key, name] of [
      ['env', 'NEXT_PUBLIC_SENTRY_ENVIRONMENT'],
      ['vercel', 'NEXT_PUBLIC_VERCEL_ENV'],
    ])
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
  }
});
