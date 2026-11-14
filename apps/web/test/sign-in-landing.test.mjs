import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signedInLanding } from '../src/lib/signed-in-landing.ts';

// Business sign-up, Task D1: where a sign-in lands.
const result = (over) => ({
  userId: 'u',
  isNew: false,
  hasProfile: false,
  managesBusiness: false,
  ...over,
});

test('a login with a page goes where it was going', () => {
  assert.equal(
    signedInLanding(result({ hasProfile: true }), '/dashboard/tips'),
    '/dashboard/tips',
  );
});

test('the admin area never needs a page', () => {
  assert.equal(signedInLanding(result(), '/ops'), '/ops');
  assert.equal(signedInLanding(result(), '/ops/people'), '/ops/people');
});

test('a business-only login lands on its business, never /sign-up', () => {
  const owner = result({ managesBusiness: true });
  assert.equal(signedInLanding(owner, '/dashboard'), '/dashboard/business');
  assert.equal(
    signedInLanding(owner, '/dashboard/tips'),
    '/dashboard/business',
  );
  assert.equal(
    signedInLanding(owner, '/dashboard/business?business=b1'),
    '/dashboard/business?business=b1',
  );
  assert.equal(signedInLanding(owner, '/statements'), '/statements');
  assert.equal(
    signedInLanding(owner, '/dashboard/businessy'),
    '/dashboard/business',
  );
});

test('anyone else without a page chooses a handle', () => {
  assert.equal(signedInLanding(result(), '/dashboard'), '/sign-up');
  // An older API that doesn't send the field reads as false.
  const { managesBusiness: _, ...old } = result();
  assert.equal(signedInLanding(old, '/dashboard/business'), '/sign-up');
});
