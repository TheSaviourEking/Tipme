import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POPUP_PREFS_UNKNOWN, popupPrefsFrom } from '../src/lib/popup-prefs.ts';

test('until the preferences load, pop-ups hide who tipped and how much, and stay quiet', () => {
  assert.deepEqual(POPUP_PREFS_UNKNOWN, {
    hideTipDetailsInPopups: true,
    tipSound: false,
  });
});

test('a failed read keeps them hidden (fails closed, for a shop counter)', () => {
  assert.deepEqual(popupPrefsFrom({ ok: false }), POPUP_PREFS_UNKNOWN);
});

test('a read sets both switches as saved', () => {
  assert.deepEqual(
    popupPrefsFrom({
      ok: true,
      data: { hideTipDetailsInPopups: false, tipSound: true },
    }),
    { hideTipDetailsInPopups: false, tipSound: true },
  );
  assert.deepEqual(
    popupPrefsFrom({
      ok: true,
      data: { hideTipDetailsInPopups: true, tipSound: false },
    }),
    { hideTipDetailsInPopups: true, tipSound: false },
  );
});

test('an older API without the switches answers with their defaults', () => {
  assert.deepEqual(popupPrefsFrom({ ok: true, data: {} }), {
    hideTipDetailsInPopups: false,
    tipSound: true,
  });
});

test('a failed read is tried again on the next ready; a good one is not repeated', async () => {
  const { createPopupPrefsLoader } = await import('../src/lib/popup-prefs.ts');
  const answers = [
    { ok: false },
    { ok: true, data: { hideTipDetailsInPopups: false, tipSound: true } },
  ];
  let reads = 0;
  const seen = [];
  const loader = createPopupPrefsLoader({
    read: async () => answers[Math.min(reads++, answers.length - 1)],
    onPrefs: (prefs) => seen.push(prefs),
  });
  await loader.load();
  assert.deepEqual(seen, [POPUP_PREFS_UNKNOWN]);
  await loader.retryIfFailed();
  assert.equal(reads, 2);
  assert.deepEqual(seen.at(-1), {
    hideTipDetailsInPopups: false,
    tipSound: true,
  });
  await loader.retryIfFailed();
  assert.equal(reads, 2, 'loaded: the next ready reads nothing');
  // Settings saving asks again, whatever happened before.
  await loader.load();
  assert.equal(reads, 3);
});
