import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signUpPath } from '../src/lib/sign-up-path.ts';

// Business sign-up, Task D3: which path the sign-up card opens on.
const CODE = 'ABCDEFGHJKMNPQ23';

test('a link from home, the header or /for-businesses picks "For businesses"', () => {
  assert.equal(signUpPath('?for=business', ''), 'business');
});

test('an invitation link skips the question: staff always get a handle', () => {
  assert.equal(signUpPath('', `#join=${CODE}`), 'join');
  assert.equal(signUpPath('?for=business', `#join=${CODE}`), 'join');
});

test('the home claim field (a handle in the link) runs "Get tipped"', () => {
  assert.equal(signUpPath('?handle=kemi_cuts', ''), 'tipped');
});

test('nothing in the link asks the question', () => {
  assert.equal(signUpPath('', ''), 'ask');
  assert.equal(signUpPath('?for=elsewhere', '#top'), 'ask');
});

test('a handle that breaks the rule is no hint, and a business link wins over a handle', () => {
  assert.equal(signUpPath('?handle=no', ''), 'ask');
  assert.equal(signUpPath('?for=business&handle=kemi', ''), 'business');
});
