import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attentionHere,
  isPaymentAttention,
  ownerAttention,
  requirementWords,
} from '../src/lib/owner-attention.ts';

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

test('no recovery email asks for one, after anything stopping tips', () => {
  const items = ownerAttention({
    profile: ready,
    payments: payments(null),
    needsRecoveryEmail: true,
  });
  assert.deepEqual(ids(items), ['set_up_payments', 'add_recovery_email']);
  assert.equal(items[1].action.href, '/dashboard/settings#recovery');
  assert.deepEqual(
    ids(
      ownerAttention({
        profile: ready,
        payments: payments('ACTIVE'),
        needsRecoveryEmail: false,
      }),
    ),
    [],
  );
});

test('fix: the recovery email reminder is not a payment problem', () => {
  const items = ownerAttention({
    profile: ready,
    payments: payments('ACTIVE'),
    needsRecoveryEmail: true,
  });
  assert.equal(items.find(isPaymentAttention), undefined);
  assert.ok(
    ownerAttention({ profile: ready, payments: payments(null) }).find(
      isPaymentAttention,
    ),
  );
});

test('a bank account still due is never counted as a detail, and leads to Get paid', () => {
  const [item] = ownerAttention({
    profile: ready,
    payments: payments('ONBOARDING', {
      requirementsDue: ['payout_destination'],
    }),
  });
  assert.equal(item.action.href, '/dashboard/settings#get-paid');
  assert.doesNotMatch(JSON.stringify(item), /payout_destination|detail/);

  const [mixed] = ownerAttention({
    profile: ready,
    payments: payments('ONBOARDING', {
      requirementsDue: ['payout_destination', 'individual.id_number'],
    }),
  });
  assert.match(mixed.body, /1 more detail\./);
  assert.equal(mixed.action.href, '/dashboard/settings#payments');
});

test("requirements read as plain words, never as the provider's field names", () => {
  assert.deepEqual(
    requirementWords([
      'individual.id_number',
      'individual.first_name',
      'individual.last_name',
      'individual.dob.year',
      'individual.dob.month',
      'business_profile.mcc',
      'payout_destination',
    ]),
    ['your ID number', 'your name', 'your date of birth', 'business details'],
  );
  assert.deepEqual(requirementWords(['some.unknown_field']), ['other details']);
  assert.deepEqual(requirementWords(['payout_destination']), []);
});

test("a business name is a business detail, not the person's name", () => {
  assert.deepEqual(requirementWords(['business_name']), ['business details']);
  assert.deepEqual(requirementWords(['company.name']), ['business details']);
  assert.deepEqual(requirementWords(['individual.first_name']), ['your name']);
});

test('the recovery reminder shows on Home and Settings only; the rest show everywhere', () => {
  const items = ownerAttention({
    profile: { emailVerified: true, pageState: 'not_live', suspended: false },
    payments: null,
    needsRecoveryEmail: true,
  });
  for (const path of [
    '/dashboard',
    '/dashboard/settings',
    '/dashboard/settings/page',
  ])
    assert.deepEqual(ids(attentionHere(items, path)), [
      'page_offline',
      'add_recovery_email',
    ]);
  for (const path of [
    '/dashboard/withdraw',
    '/dashboard/tips',
    '/dashboard/tips/t1',
    '/dashboard/reports/2026-W44',
    '/dashboard/qr',
    '/dashboard/settingsx',
  ])
    assert.deepEqual(ids(attentionHere(items, path)), ['page_offline']);
  assert.equal(attentionHere(null, '/dashboard'), null);
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
