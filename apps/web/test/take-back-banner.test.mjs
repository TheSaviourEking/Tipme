import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeBackBannerWords } from '../src/lib/take-back-words.ts';

const WHY = 'The username infringes a trademark.';

test('the banner words for current and old', () => {
  const current = takeBackBannerWords({
    id: 'id',
    handle: 'kemi',
    kind: 'current',
    current: 'kemi',
    why: WHY,
    // The last moment of 10 November in Lagos.
    dueAt: '2026-11-10T22:59:59.999Z',
  });
  assert.deepEqual(current, {
    title:
      'TipMe needs your username @kemi back. Choose a new one by the end of 10 November 2026.',
    why: WHY,
    action: 'Choose a new username',
  });
  const old = takeBackBannerWords({
    id: 'id',
    handle: 'kemi_old',
    kind: 'old',
    current: 'kemi',
    why: WHY,
    dueAt: '2026-11-10T22:59:59.999Z',
  });
  assert.deepEqual(old, {
    title:
      'Links that use your old username @kemi_old will stop working after 10 November 2026. Your username @kemi stays.',
    why: WHY,
    action: null,
  });
  for (const words of [current, old])
    assert.equal(/[\u2013\u2014]/.test(words.title), false);
});

test('the dashboard notice words after an assignment', async () => {
  const { freeChangeWords } = await import('../src/lib/take-back-words.ts');
  const words = freeChangeWords({
    until: '2026-12-10T10:00:00.000Z',
    assignedHandle: 'page_x7k2qd',
    old: 'kemi',
  });
  assert.deepEqual(words, {
    title:
      'Your page has a new username, @page_x7k2qd. Links and QR codes with @kemi no longer work. You can change it once, for free, until 10 December 2026.',
    action: 'Choose a new username',
  });
  assert.equal(/[\u2013\u2014]/.test(words.title), false);
});

test('the take-back state words staff read', async () => {
  const { takeBackStateWords } = await import('../src/lib/take-back-words.ts');
  const at = (state, dueAt = null) => takeBackStateWords({ state, dueAt });
  assert.equal(at('approved'), 'Notice being sent');
  assert.equal(
    at('noticed', '2026-11-10T22:59:59.999Z'),
    'Notice sent, due 10 November 2026',
  );
  assert.equal(at('due'), 'Being completed');
  assert.equal(at('done'), 'Done');
  assert.equal(at('cancelled'), 'Cancelled');
});
