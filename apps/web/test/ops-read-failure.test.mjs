import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFailure, withFreshCode } from '../src/lib/ops-answers.ts';

const ok = (data) => ({ ok: true, status: 200, data });
const no = (status, code, extra = {}) => ({
  ok: false,
  status,
  code,
  ...extra,
});

// A read of a code-protected admin screen (the audit log, the people list) ends in one of four
// ways, and each one needs its own words. The old screens said "your role may not include it" for all.

test('a read that needed a code says so, and does not blame the role', () => {
  const failure = readFailure(no(403, 'FRESH_CODE_REQUIRED'), 'the audit log');
  assert.equal(failure.kind, 'needs_code');
  assert.match(failure.words, /fresh authenticator code/);
  assert.doesNotMatch(failure.words, /role/);
});

test('a genuine refusal for the role says the role does not include it', () => {
  for (const code of ['FORBIDDEN', 'PERMISSION_NOT_HELD']) {
    const failure = readFailure(no(403, code), 'the audit log');
    assert.equal(failure.kind, 'forbidden');
    assert.equal(failure.words, 'Your role doesn’t include the audit log.');
  }
});

test('a lost connection has its own words, not a role problem', () => {
  const failure = readFailure(no(0, 'NETWORK'), 'the audit log');
  assert.equal(failure.kind, 'no_answer');
  assert.match(failure.words, /connection/);
  assert.doesNotMatch(failure.words, /role/);
});

test('anything else is a plain failure that can be tried again', () => {
  const failure = readFailure(no(500, 'INTERNAL_ERROR'), 'the audit log');
  assert.equal(failure.kind, 'other');
  assert.doesNotMatch(failure.words, /role/);
});

// The page-level contract: a stale code means ask, then load. Declining leaves a needs_code read.

test('a read refused for a code asks once, then loads', async () => {
  let sent = 0;
  const result = await withFreshCode(
    async () => (++sent === 1 ? no(403, 'FRESH_CODE_REQUIRED') : ok([1])),
    async () => true,
  );
  assert.equal(sent, 2);
  assert.deepEqual(result, ok([1]));
});

test('declining the code leaves a read the page can offer again', async () => {
  const result = await withFreshCode(
    async () => no(403, 'FRESH_CODE_REQUIRED'),
    async () => false,
  );
  assert.equal(readFailure(result, 'the people').kind, 'needs_code');
});

test('a genuine FORBIDDEN is never answered with the code prompt', async () => {
  let asked = 0;
  const result = await withFreshCode(
    async () => no(403, 'FORBIDDEN'),
    async () => {
      asked++;
      return true;
    },
  );
  assert.equal(asked, 0);
  assert.equal(readFailure(result, 'the people').kind, 'forbidden');
});
