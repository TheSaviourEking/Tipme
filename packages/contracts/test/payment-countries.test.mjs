import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAYMENT_COUNTRIES,
  apiErrorCodes,
  bachsOnboardingRequestSchema,
  isPaymentCountry,
} from '../dist/index.js';

// The payment partner's payout countries (owner's choice, 14 Nov 2026), Nigeria first. The brief
// said 29, but the partner's payout page names 28 distinct countries (NG; GH KE TZ UG; GB; 20 SEPA;
// US; CA), so the list holds those 28.

test('the list: 28 countries, Nigeria first, then A–Z by English name', () => {
  assert.equal(PAYMENT_COUNTRIES.length, 28);
  assert.deepEqual(PAYMENT_COUNTRIES[0], { code: 'NG', name: 'Nigeria' });
  const rest = PAYMENT_COUNTRIES.slice(1).map((c) => c.name);
  assert.deepEqual(
    rest,
    [...rest].sort((a, b) => a.localeCompare(b, 'en')),
  );
});

test('the list: no duplicates, every code is uppercase alpha-2', () => {
  const codes = PAYMENT_COUNTRIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(new Set(PAYMENT_COUNTRIES.map((c) => c.name)).size, 28);
  for (const code of codes) assert.match(code, /^[A-Z]{2}$/);
});

test('the list holds exactly the partner’s payout countries', () => {
  assert.deepEqual(
    PAYMENT_COUNTRIES.map((c) => c.code).sort(),
    [
      'NG',
      'GH',
      'KE',
      'TZ',
      'UG',
      'GB',
      'AT',
      'BE',
      'CY',
      'DE',
      'EE',
      'ES',
      'FI',
      'FR',
      'GR',
      'HR',
      'IE',
      'IT',
      'LT',
      'LU',
      'LV',
      'MT',
      'NL',
      'PT',
      'SI',
      'SK',
      'US',
      'CA',
    ].sort(),
  );
});

test('isPaymentCountry takes listed codes only, exactly as written', () => {
  assert.equal(isPaymentCountry('NG'), true);
  assert.equal(isPaymentCountry('GH'), true);
  assert.equal(isPaymentCountry('ZZ'), false);
  assert.equal(isPaymentCountry('ng'), false);
  assert.equal(isPaymentCountry('XX'), false);
});

test('onboarding takes a listed country, or none (re-checking an existing account)', () => {
  const parse = (body) => bachsOnboardingRequestSchema.safeParse(body).success;
  assert.equal(parse({ country: 'GH', entityType: 'individual' }), true);
  assert.equal(parse({ entityType: 'individual' }), true);
  assert.equal(parse({ country: 'ZZ', entityType: 'individual' }), false);
  assert.equal(parse({ country: 'gh', entityType: 'individual' }), false);
  assert.equal(parse({ country: 'XX', entityType: 'individual' }), false);
});

test('an unlisted country has its own error code', () => {
  assert.ok(apiErrorCodes.includes('COUNTRY_NOT_SUPPORTED'));
});
