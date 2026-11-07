import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hintFromAnswer } from '../src/lib/signed-in-hint.ts';

test('a working call to the person’s own routes means signed in', () => {
  assert.equal(hintFromAnswer('/v1/me/profile', 200), true);
  assert.equal(hintFromAnswer('/v1/me/events', 204), true);
});

test('a 401 on their own routes, or a finished sign-out, means signed out', () => {
  assert.equal(hintFromAnswer('/v1/me/profile', 401), false);
  assert.equal(hintFromAnswer('/v1/auth/sign-out', 204), false);
});

test('anything else says nothing', () => {
  // An admin route's 401 is about the admin grant, not the session.
  assert.equal(hintFromAnswer('/v1/ops/me', 401), undefined);
  assert.equal(hintFromAnswer('/v1/me/business-roles', 404), undefined);
  assert.equal(hintFromAnswer('/v1/me/profile', 503), undefined);
  assert.equal(hintFromAnswer('/v1/auth/sign-out', 500), undefined);
  assert.equal(hintFromAnswer('/v1/public/profiles/ada', 200), undefined);
});
