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
    assert.equal(/[–—]/.test(words.title), false);
});
