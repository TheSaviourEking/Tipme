import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  dashboardLoadFailedBody,
  profileReadOutcome,
} from '../src/lib/dashboard-load.ts';

// UI audit (15 Nov 2026), item 3: a server or network error reading the profile is not "signed out".

test('only the signed-out answer goes to Sign in', () => {
  assert.equal(profileReadOutcome({ ok: false, status: 401 }), 'signed_out');
});

test('a page reads as a page, and a 404 is a login with no page yet', () => {
  assert.equal(profileReadOutcome({ ok: true, status: 200 }), 'page');
  assert.equal(profileReadOutcome({ ok: false, status: 404 }), 'no_page');
});

test('server errors, limits and refusals are failures to read, never signed out', () => {
  for (const status of [500, 502, 503, 504, 429, 403, 400])
    assert.equal(profileReadOutcome({ ok: false, status }), 'failed', status);
});

test('no answer at all (offline, dropped, timed out) is unreachable', () => {
  assert.equal(profileReadOutcome({ ok: false, status: 0 }), 'unreachable');
});

test('the words name no cause they can’t know and promise nothing', () => {
  for (const outcome of ['failed', 'unreachable']) {
    const words = dashboardLoadFailedBody(outcome);
    assert.match(words, /try again/i);
    assert.doesNotMatch(words, /sign in|signed out|safe|provider/i);
  }
});

test('the shell redirects to Sign in only on the signed-out outcome', () => {
  const shell = readFileSync(
    new URL('../src/app/dashboard/dashboard-shell.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(shell, /status !== 404/);
  assert.match(shell, /profileReadOutcome\(/);
});
