import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ISSUE_KINDS,
  opsBachsAccountRecoverySchema,
  opsBachsCheckoutRecoverySchema,
} from '../dist/index.js';

const reason = 'Confirmed the provider dashboard record';

test('operator recovery requests require a dashboard attestation and valid scoped IDs', () => {
  assert.ok(ISSUE_KINDS.includes('payment_attempt_unresolved'));
  assert.ok(ISSUE_KINDS.includes('payment_account_unresolved'));

  const checkout = {
    issueId: randomUUID(),
    attemptId: randomUUID(),
    checkoutId: 'chk_recovery123',
    dashboardVerified: true,
    reason,
  };
  assert.equal(
    opsBachsCheckoutRecoverySchema.safeParse(checkout).success,
    true,
  );
  assert.equal(
    opsBachsCheckoutRecoverySchema.safeParse({
      ...checkout,
      dashboardVerified: false,
    }).success,
    false,
  );
  assert.equal(
    opsBachsCheckoutRecoverySchema.safeParse({
      ...checkout,
      checkoutId: 'https://bachs.io/checkout/chk_recovery123',
    }).success,
    false,
  );

  const account = {
    issueId: randomUUID(),
    accountReference: 'acct_recovery123',
    dashboardVerified: true,
    reason,
  };
  assert.equal(opsBachsAccountRecoverySchema.safeParse(account).success, true);
  assert.equal(
    opsBachsAccountRecoverySchema.safeParse({
      ...account,
      accountReference: 'acct_recovery123:chk_other',
    }).success,
    false,
  );
});

test('Bachs identifiers are opaque: no prefix is required, separators and spaces are refused', () => {
  const base = {
    issueId: randomUUID(),
    attemptId: randomUUID(),
    dashboardVerified: true,
    reason,
  };
  for (const checkoutId of ['legacy-checkout-123', 'cs.Opaque_9'])
    assert.equal(
      opsBachsCheckoutRecoverySchema.safeParse({ ...base, checkoutId }).success,
      true,
      checkoutId,
    );
  assert.equal(
    opsBachsAccountRecoverySchema.safeParse({
      issueId: base.issueId,
      accountReference: 'legacy-account-123',
      dashboardVerified: true,
      reason,
    }).success,
    true,
  );
  for (const checkoutId of [
    '',
    'acct:chk',
    'has space',
    'a/b',
    'x'.repeat(201),
  ])
    assert.equal(
      opsBachsCheckoutRecoverySchema.safeParse({ ...base, checkoutId }).success,
      false,
      JSON.stringify(checkoutId),
    );
});
