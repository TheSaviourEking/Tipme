import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mailFailoverGroup,
  mailHealthAlerter,
  mailHealthAlertText,
} from '../dist/handlers/mail-failover.js';

// Automatic email failover (owner, 23 Nov 2026): staff hear when a provider trips, when it is still
// down (the breaker repeats that at most every 6 hours) and when it recovers, through the same
// alert route as the reserve alerts. Provider names only: no address, key or error body.

const labels = {
  zeptomail: 'ZeptoMail',
  brevo: 'Brevo',
  ses: 'Amazon SES',
  mock: 'Pretend provider',
};
const until = new Date('2026-11-23T13:30:00Z');

test('the alert says which provider rests, until when (Lagos time), why, and where mail goes now', () => {
  assert.equal(
    mailHealthAlertText(
      {
        provider: 'zeptomail',
        change: 'tripped',
        kind: 'send',
        reason: '3 send failures in 5 min (last: http_503)',
        until,
      },
      { labels, backup: 'brevo' },
    ),
    'TipMe staff alert: email provider ZeptoMail is resting until 14:30 (Lagos) after 3 send failures in 5 min (last: http_503). New mail goes through Brevo. Ops → Providers shows it; staff can fix the provider or clear this.',
  );
  assert.equal(
    mailHealthAlertText(
      {
        provider: 'zeptomail',
        change: 'still_down',
        kind: 'codes',
        reason: '3 of 3 trial codes unused',
        until,
      },
      { labels, backup: 'brevo' },
    ),
    'TipMe staff alert: email provider ZeptoMail is still down (3 of 3 trial codes unused), resting until 14:30 (Lagos). Mail goes through Brevo.',
  );
  assert.equal(
    mailHealthAlertText(
      {
        provider: 'zeptomail',
        change: 'recovered',
        kind: 'codes',
        reason: 'x',
        until: null,
      },
      { labels, backup: 'brevo' },
    ),
    'TipMe staff alert: email provider ZeptoMail has recovered; mail goes through it again.',
  );
});

test('the backup is the other provider of the group; the default joins the fallbacks', () => {
  const configured = new Set(['zeptomail', 'brevo', 'mock']);
  assert.deepEqual(
    mailFailoverGroup('zeptomail', ['brevo'], configured, true),
    ['zeptomail', 'brevo'],
  );
  assert.deepEqual(
    mailFailoverGroup('zeptomail', ['mock', 'brevo'], configured, true),
    ['zeptomail', 'brevo'],
  );
  assert.deepEqual(mailFailoverGroup('zeptomail', ['ses'], configured, false), [
    'zeptomail',
  ]);
});

test('the alert is posted to the alert route; a failure is thrown for the breaker to log', async () => {
  const posts = [];
  const alert = mailHealthAlerter({
    url: 'https://hooks.example.test/x',
    labels,
    group: ['zeptomail', 'brevo'],
    fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body).text);
      return new Response('ok', { status: 200 });
    },
  });
  await alert({
    provider: 'brevo',
    change: 'tripped',
    kind: 'codes',
    reason: '4 of 6 codes unused in 10 min',
    until,
  });
  assert.match(
    posts[0],
    /email provider Brevo is resting until 14:30 \(Lagos\) after 4 of 6 codes unused in 10 min\. New mail goes through ZeptoMail\./,
  );
  const unrouted = [];
  const nowhere = mailHealthAlerter({
    url: undefined,
    labels,
    group: ['zeptomail', 'brevo'],
    log: (e) => unrouted.push(e.event),
  });
  await assert.rejects(
    nowhere({
      provider: 'brevo',
      change: 'recovered',
      kind: null,
      reason: null,
      until: null,
    }),
  );
  assert.deepEqual(unrouted, ['mail.health_alert_unrouted']);
});
