import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEvent, scrubSpan } from '../src/lib/sentry-scrub.ts';
import { sentryOptions } from '../src/lib/sentry-options.ts';

// Spans in a transaction carry URLs and values too (fetch/navigation descriptions, http.url, query
// attributes), so they get the same rules as the rest of the event (ADR-0005).
test('every span in a transaction is scrubbed; timings, op and status stay', () => {
  const event = scrubEvent({
    type: 'transaction',
    contexts: {
      trace: {
        trace_id: 't1',
        span_id: 's0',
        op: 'http.server',
        data: {
          'http.url': 'https://usetipme.xyz/tip/01a1?token=secret-token',
          'url.query': '?token=secret-token',
          'http.status_code': 200,
        },
      },
    },
    spans: [
      {
        span_id: 's1',
        parent_span_id: 's0',
        op: 'http.client',
        status: 'ok',
        start_timestamp: 10,
        timestamp: 11.5,
        description:
          'GET https://api.usetipme.xyz/v1/tips/01a1/status?token=secret-token',
        data: {
          'http.url':
            'https://api.usetipme.xyz/v1/tips/01a1?token=secret-token',
          'url.full': 'https://api.usetipme.xyz/v1/tips?token=secret-token#x',
          'url.query': '?token=secret-token',
          'http.query': '?token=secret-token',
          'http.method': 'GET',
          note: 'mail ada@example.com or call +234 803 123 4567 now',
          'http.response.status_code': 200,
          supporterKey: 'abc',
        },
      },
      {
        span_id: 's2',
        op: 'navigation',
        status: 'ok',
        start_timestamp: 12,
        timestamp: 13,
        description: 'ada@example.com +2348031234567',
        data: {},
      },
    ],
  });
  const [fetchSpan, plain] = event.spans;
  assert.equal(
    fetchSpan.description,
    'GET https://api.usetipme.xyz/v1/tips/01a1/status',
  );
  assert.equal(
    fetchSpan.data['http.url'],
    'https://api.usetipme.xyz/v1/tips/01a1',
  );
  assert.equal(fetchSpan.data['url.full'], 'https://api.usetipme.xyz/v1/tips');
  assert.ok(!('url.query' in fetchSpan.data));
  assert.ok(!('http.query' in fetchSpan.data));
  assert.ok(!('supporterKey' in fetchSpan.data));
  assert.equal(fetchSpan.data.note, 'mail [email] or call [phone] now');
  assert.equal(plain.description, '[email] [phone]');
  // Not sensitive: kept as is.
  assert.equal(fetchSpan.op, 'http.client');
  assert.equal(fetchSpan.status, 'ok');
  assert.equal(fetchSpan.start_timestamp, 10);
  assert.equal(fetchSpan.timestamp, 11.5);
  assert.equal(fetchSpan.parent_span_id, 's0');
  assert.equal(fetchSpan.data['http.method'], 'GET');
  assert.equal(fetchSpan.data['http.response.status_code'], 200);
  // The root span lives in contexts.trace.
  const root = event.contexts.trace;
  assert.equal(root.data['http.url'], 'https://usetipme.xyz/tip/01a1');
  assert.ok(!('url.query' in root.data));
  assert.equal(root.data['http.status_code'], 200);
  assert.equal(root.op, 'http.server');
  assert.ok(!JSON.stringify(event).includes('secret-token'));
});

test('scrubSpan cleans a standalone span the same way', () => {
  const span = scrubSpan({
    span_id: 's1',
    trace_id: 't1',
    op: 'ui.interaction.click',
    status: 'ok',
    start_timestamp: 1,
    description: 'GET /tip/1?token=abc by ada@example.com',
    data: { 'url.full': 'https://usetipme.xyz/@ada?src=qr' },
  });
  assert.equal(span.description, 'GET /tip/1 by [email]');
  assert.equal(span.data['url.full'], 'https://usetipme.xyz/@ada');
  assert.equal(span.op, 'ui.interaction.click');
});

test('error events are untouched by span rules', () => {
  const event = scrubEvent({
    contexts: { trace: { data: { 'url.query': '?a=1' } } },
  });
  assert.deepEqual(event.contexts.trace.data, { 'url.query': '?a=1' });
});

// Standalone spans skip the transaction, so beforeSendSpan (wrapped for the static lifecycle,
// otherwise the SDK ignores it) scrubs them with the same helper.
test('beforeSendSpan is wrapped for static spans and scrubs a span', () => {
  const sdk = {
    withStaticSpan: (callback) =>
      Object.assign(callback, { wrappedForStatic: true }),
  };
  const options = sentryOptions(undefined, sdk);
  assert.equal(options.beforeSendSpan.wrappedForStatic, true);
  const out = options.beforeSendSpan({
    span_id: 's',
    trace_id: 't',
    status: 'ok',
    start_timestamp: 1,
    description: 'GET https://x.test/v1?token=abc',
    data: {},
  });
  assert.equal(out.description, 'GET https://x.test/v1');
});
