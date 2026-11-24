import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mailProviderNameSchema,
  opsMailListQuerySchema,
  opsMailOverrideSchema,
  opsMailSwitchSchema,
} from '../dist/index.js';

// Brevo is a provider staff can switch codes, receipts and alerts to by hand (owner, 23 Nov 2026):
// the ops switch, a person's override and the email console's filter all accept it.

test('the provider names are the mail package’s, Brevo included', () => {
  assert.deepEqual(mailProviderNameSchema.options, [
    'mock',
    'zeptomail',
    'ses',
    'brevo',
  ]);
  assert.equal(mailProviderNameSchema.safeParse('postmark').success, false);
});

test('staff can switch to Brevo, pin an account to it and filter by it', () => {
  const reason = 'ZeptoMail is not delivering sign-in codes';
  assert.equal(
    opsMailSwitchSchema.safeParse({ provider: 'brevo', reason }).success,
    true,
  );
  assert.equal(
    opsMailOverrideSchema.safeParse({
      account: 'ada',
      provider: 'brevo',
      reason,
    }).success,
    true,
  );
  assert.equal(
    opsMailListQuerySchema.safeParse({ provider: 'brevo' }).data?.provider,
    'brevo',
  );
});
