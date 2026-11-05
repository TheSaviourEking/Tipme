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
