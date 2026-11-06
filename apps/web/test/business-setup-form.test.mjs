import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  setupFieldErrors,
  suggestSlug,
} from '../src/lib/business/setup-form.ts';

// PR B1: the business setup forms' suggestions and field errors.

test('a slug is suggested from the name, within the length', () => {
  assert.equal(suggestSlug('The Yellow Chilli', 40), 'the-yellow-chilli');
  assert.equal(suggestSlug('  Café Ọlá & Sons!! ', 40), 'cafe-ola-and-sons');
  assert.equal(suggestSlug('Victoria Island', 5), 'victo');
  assert.equal(suggestSlug('Ab - cd', 3), 'ab', 'no hyphen left at the end');
  assert.equal(suggestSlug('***', 40), '');
});

test('taken and locked slugs are told next to the slug field', () => {
  assert.deepEqual(setupFieldErrors({ code: 'BUSINESS_SLUG_TAKEN' }).fields, {
    slug: 'That address is taken. Try another.',
  });
  assert.ok(
    setupFieldErrors({ code: 'LOCATION_SLUG_TAKEN' }).fields['location.slug'],
  );
  assert.ok(setupFieldErrors({ code: 'SLUG_LOCKED' }).fields.slug);
  assert.ok(
    setupFieldErrors({ code: 'SLUG_LOCKED' }, { locationAtTop: true }).fields[
      'location.slug'
    ],
  );
});

test("the API's field paths map to the form's fields", () => {
  const { fields } = setupFieldErrors({
    code: 'VALIDATION_FAILED',
    fields: ['contactEmail', 'location.address'],
  });
  assert.deepEqual(Object.keys(fields).sort(), [
    'contactEmail',
    'location.address',
  ]);
  const top = setupFieldErrors(
    { code: 'VALIDATION_FAILED', fields: ['slug'] },
    { locationAtTop: true },
  );
  assert.deepEqual(Object.keys(top.fields), ['location.slug']);
});

test('anything else is one line for the form, never a field', () => {
  for (const code of [
    'EMAIL_VERIFICATION_REQUIRED',
    'RATE_LIMITED',
    'NETWORK',
    'INTERNAL_ERROR',
  ]) {
    const result = setupFieldErrors({ code });
    assert.deepEqual(result.fields, {});
    assert.ok(result.form, code);
  }
});

test('a location slug TipMe keeps says so', () => {
  const { fields } = setupFieldErrors(
    { code: 'VALIDATION_FAILED', fields: ['location.slug'] },
    { locationSlug: 'people' },
  );
  assert.equal(
    fields['location.slug'],
    'That address is kept for TipMe. Try another.',
  );
  const top = setupFieldErrors(
    { code: 'VALIDATION_FAILED', fields: ['slug'] },
    { locationAtTop: true, locationSlug: 'People' },
  );
  assert.equal(
    top.fields['location.slug'],
    'That address is kept for TipMe. Try another.',
  );
});
