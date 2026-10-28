import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEvent } from '../src/lib/sentry-scrub.ts';

// What may leave the browser or the web server in a Sentry event: no query strings or fragments
// (a receipt link carries the tip's status token), no user, cookies or headers.

test('URLs lose their query string and fragment everywhere in the event', () => {
  const event = scrubEvent({
    request: {
      url: 'https://usetipme.xyz/tip/01a1?token=secret-status-token#paid',
      query_string: 'token=secret-status-token',
      cookies: { tipme_session: 'abc' },
      headers: { cookie: 'tipme_session=abc', 'user-agent': 'x' },
    },
    user: { id: '1', email: 'someone@example.com', ip_address: '1.2.3.4' },
    breadcrumbs: [
      {
        category: 'navigation',
        data: { from: '/tip/01a1?token=a', to: '/@ada?src=qr' },
      },
      {
        category: 'fetch',
        data: {
          url: 'https://api.usetipme.xyz/v1/tips/01a1/status?x=1',
          method: 'GET',
        },
      },
    ],
  });
  assert.equal(event.request.url, 'https://usetipme.xyz/tip/01a1');
  assert.equal(event.request.query_string, undefined);
  assert.equal(event.request.cookies, undefined);
  assert.equal(event.request.headers, undefined);
  assert.equal(event.user, undefined);
  assert.deepEqual(event.breadcrumbs[0].data, {
    from: '/tip/01a1',
    to: '/@ada',
  });
  assert.deepEqual(event.breadcrumbs[1].data, {
    url: 'https://api.usetipme.xyz/v1/tips/01a1/status',
    method: 'GET',
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /secret-status-token|someone@|tipme_session/,
  );
});

test('breadcrumbs that carry typed text (console, UI input) are dropped', () => {
  const event = scrubEvent({
    breadcrumbs: [
      { category: 'console', message: 'Thanks for the coffee, Ada!' },
      { category: 'ui.input', message: 'textarea#message' },
      { category: 'navigation', data: { to: '/@ada' } },
    ],
  });
  assert.deepEqual(
    event.breadcrumbs.map((b) => b.category),
    ['navigation'],
  );
});

test('an event without these parts passes through unchanged', () => {
  assert.deepEqual(scrubEvent({ message: 'x' }), { message: 'x' });
});
