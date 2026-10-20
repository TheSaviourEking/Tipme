import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  issuePreviewTicket,
  previewServerKey,
  validPreviewTicket,
} from '../dist/index.js';

const password = 'p'.repeat(40);
const now = 1_800_000_000_000;

test('a ticket is valid for 12 hours with the same password only', () => {
  const ticket = issuePreviewTicket(password, now);
  assert.match(ticket, /^\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(validPreviewTicket(ticket, password, now + 1000), true);
  assert.equal(
    validPreviewTicket(ticket, password, now + 12 * 3600_000 + 1),
    false,
  );
  assert.equal(validPreviewTicket(ticket, 'q'.repeat(40), now), false);
});

test('forged, malformed or far-future tickets are refused', () => {
  const [expires] = issuePreviewTicket(password, now).split('.');
  for (const bad of [
    undefined,
    '',
    'x',
    `${expires}.`,
    `${expires}.${'A'.repeat(43)}`,
    `${now + 48 * 3600_000}.${'A'.repeat(43)}`,
    'a'.repeat(200),
  ])
    assert.equal(validPreviewTicket(bad, password, now), false, String(bad));
});

test('the server key is stable for a password and differs between passwords', () => {
  assert.equal(previewServerKey(password), previewServerKey(password));
  assert.notEqual(previewServerKey(password), previewServerKey('q'.repeat(40)));
  assert.match(previewServerKey(password), /^[A-Za-z0-9_-]{43}$/);
});
