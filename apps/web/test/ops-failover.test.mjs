import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveNowNote, trialNote } from '../src/lib/ops-failover.ts';

// Ops → Providers, automatic failover (owner, 23 Nov 2026): the card names where mail goes now
// and, when that isn't the active provider, exactly why.

const card = (name, label, active, health) => ({ name, label, active, health });
const data = (zeptoHealth, extra = {}) => ({
  providers: [
    card('zeptomail', 'ZeptoMail', true, zeptoHealth),
    card('brevo', 'Brevo', false, { state: 'healthy' }),
  ],
  failover: {
    configured: true,
    fixed: false,
    live: 'brevo',
    backup: 'brevo',
    ...extra,
  },
});

test('the active provider live: just its name', () => {
  assert.equal(
    liveNowNote(data({ state: 'healthy' }, { live: 'zeptomail' })),
    'Live now: ZeptoMail.',
  );
});

test('the backup live: says the active one is resting until when (Lagos), or on trial', () => {
  assert.equal(
    liveNowNote(data({ state: 'resting', until: '2026-11-23T18:58:00Z' })),
    'Live now: Brevo (ZeptoMail is resting until 19:58).',
  );
  assert.equal(
    liveNowNote(data({ state: 'trial', until: null })),
    'Live now: Brevo (ZeptoMail is on trial).',
  );
});

test('trial wording for each kind of trip', () => {
  assert.equal(
    trialNote('codes'),
    'the next few sign-in and other codes go through it, and once people use them, it’s back',
  );
  assert.equal(
    trialNote('send'),
    'one email goes through it, and once that works, it’s back',
  );
});
