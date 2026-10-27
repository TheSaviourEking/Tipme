import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerAttention } from '../src/lib/owner-attention.ts';

const ready = { emailVerified: true, pageState: 'live', suspended: false };
const payments = (status, extra = {}) => ({
  enabled: true,
  status,
  chargesEnabled: status === 'ACTIVE',
  requirementsDue: [],
  ...extra,
});
const ids = (items) => items.map((item) => item.id);

test('a ready owner has nothing to do', () => {
  assert.deepEqual(
    ownerAttention({ profile: ready, payments: payments('ACTIVE') }),
    [],
  );
});

test('without a payment account, the owner is told supporters cannot tip yet and where to fix it', () => {
  const [item] = ownerAttention({ profile: ready, payments: payments(null) });
  assert.equal(item.id, 'set_up_payments');
  assert.match(item.body, /can’t tip you/);
  assert.deepEqual(item.action, {
    href: '/dashboard/settings#payments',
    label: 'Set up payments',
  });
  assert.equal(item.navHref, '/dashboard/settings');
  // A failed setup is the same next step: start again.
  assert.deepEqual(
    ids(ownerAttention({ profile: ready, payments: payments('FAILED') })),
    ['set_up_payments'],
  );
});

test('an unverified email comes first, because payment setup needs it', () => {
  const [item] = ownerAttention({
    profile: { ...ready, emailVerified: false },
    payments: payments(null),
  });
  assert.equal(item.id, 'verify_email');
  assert.equal(item.action.href, '/dashboard/settings#contact');
});

test('a started setup asks the owner to finish it and says how much is left', () => {
  const [item] = ownerAttention({
    profile: ready,
    payments: payments('ONBOARDING', { requirementsDue: ['a', 'b', 'c'] }),
  });
  assert.equal(item.id, 'finish_payments');
  assert.match(item.body, /3 more details/);
  assert.equal(item.action.label, 'Continue setup');
  for (const state of [
    payments('RESTRICTED'),
    payments('ACTIVE', { chargesEnabled: false }),
  ])
    assert.deepEqual(ids(ownerAttention({ profile: ready, payments: state })), [
      'finish_payments',
    ]);
});

test('while TipMe checks an uncertain setup, the owner is told to wait, not to start again', () => {
  for (const status of ['CREATING', 'UNKNOWN']) {
    const [item] = ownerAttention({
      profile: ready,
      payments: payments(status),
    });
    assert.equal(item.id, 'payments_checking');
    assert.equal(item.action, undefined);
  }
});

test('an offline page is flagged, unless TipMe paused it (the shell already says so)', () => {
  const offline = { ...ready, pageState: 'not_live' };
  assert.deepEqual(
    ids(ownerAttention({ profile: offline, payments: payments('ACTIVE') })),
    ['page_offline'],
  );
  assert.deepEqual(
    ownerAttention({
      profile: { ...offline, suspended: true },
      payments: payments('ACTIVE'),
    }),
    [],
  );
});

test('with test payments (no provider setup) or an unreadable account, no payment notice is invented', () => {
  assert.deepEqual(
    ownerAttention({
      profile: ready,
      payments: { ...payments(null), enabled: false },
    }),
    [],
  );
  assert.deepEqual(ownerAttention({ profile: ready, payments: null }), []);
});

test('payments come before the page, so the most urgent fix is first', () => {
  assert.deepEqual(
    ids(
      ownerAttention({
        profile: { ...ready, pageState: 'not_live' },
        payments: payments(null),
      }),
    ),
    ['set_up_payments', 'page_offline'],
  );
});

test('while supporters can’t tip yet, the owner hears how often the page was opened today', () => {
  const [item] = ownerAttention({
    profile: ready,
    payments: payments(null),
    visitsToday: 3,
  });
  assert.equal(
    item.body,
    'Your page was opened 3 times today, but nobody could tip you yet. It takes a few minutes to set up.',
  );
  const [once] = ownerAttention({
    profile: ready,
    payments: payments('ONBOARDING'),
    visitsToday: 1,
  });
  assert.match(
    once.body,
    /^Your page was opened once today, but nobody could tip you yet\./,
  );
  // No visits, analytics off (null) or nothing blocking tips: the usual words, no number.
  for (const visitsToday of [0, null, undefined])
    assert.doesNotMatch(
      ownerAttention({
        profile: ready,
        payments: payments(null),
        visitsToday,
      })[0].body,
      /opened/,
    );
  assert.doesNotMatch(
    ownerAttention({
      profile: { ...ready, pageState: 'not_live' },
      payments: payments('ACTIVE'),
      visitsToday: 4,
    })[0].body,
    /opened/,
  );
});
