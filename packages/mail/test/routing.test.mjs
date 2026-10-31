import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPretendRecipient, resolveMailProvider } from '../dist/index.js';

// Addresses that can never receive mail go to the pretend inbox on copies that have one, so test
// sign-ups (the release check, e2e) never send real mail that bounces. Production has no pretend
// provider, so the rule can't apply there.

const route = (to, extra = {}) =>
  resolveMailProvider({
    pinned: null,
    override: null,
    active: 'zeptomail',
    configured: new Set(['zeptomail', 'mock']),
    to,
    pretendDomains: ['release-check.usetipme.xyz'],
    ...extra,
  });

test('reserved test domains and the configured ones go to the pretend inbox', () => {
  assert.equal(route('r@rc-1a2b3c.example'), 'mock');
  assert.equal(route('kemi@e2e-1234.test'), 'mock');
  assert.equal(route('a@b.invalid'), 'mock');
  assert.equal(route('Release@Release-Check.UseTipMe.xyz'), 'mock');
  assert.equal(route('x@sub.release-check.usetipme.xyz'), 'mock');
});

test('real addresses use the active provider', () => {
  assert.equal(route('ada@gmail.com'), 'zeptomail');
  assert.equal(
    route('someone@example.com'),
    'zeptomail',
    'example.com is not .example',
  );
  assert.equal(route('x@notrelease-check.usetipme.xyz'), 'zeptomail');
});

test('without a pretend provider (production), nothing is rerouted', () => {
  assert.equal(
    route('r@rc-1a2b3c.example', { configured: new Set(['zeptomail']) }),
    'zeptomail',
  );
});

test('a provider test keeps its pin, whatever the address', () => {
  assert.equal(route('staff@x.example', { pinned: 'ses' }), 'ses');
});

test('isPretendRecipient reads the domain only, case-insensitively', () => {
  assert.equal(isPretendRecipient('A@B.EXAMPLE', []), true);
  assert.equal(isPretendRecipient('a@example', []), true);
  assert.equal(isPretendRecipient('not an address', []), false);
});
