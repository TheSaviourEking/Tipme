import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skinTipLabel } from '../src/components/tip-skin-label.ts';

// The in-page Tip's fixed words per skin (addendum 2026-11-27-studio-creator-professional §6.5):
// part of the look, never stored. The amount still flows into the button's name (§8).

// Ruling S-R5 (WCAG 2.5.3): the name is the words the button shows, both lines and the amount.
test('Creator\'s Tip reads "Support my work" over "Give, tip or appreciate", named by what it shows', () => {
  assert.deepEqual(skinTipLabel('creator', '200000'), {
    name: 'Support my work Give, tip or appreciate ₦2,000',
    lines: ['Support my work', 'Give, tip or appreciate'],
  });
  // Minor units as a number or a bigint, and kobo, as everywhere money is written.
  assert.equal(
    skinTipLabel('creator', 250050)?.name,
    'Support my work Give, tip or appreciate ₦2,500.50',
  );
  assert.equal(
    skinTipLabel('creator', BigInt('999999999999'))?.name,
    'Support my work Give, tip or appreciate ₦9,999,999,999.99',
  );
  // No valid amount: the decided words alone.
  assert.deepEqual(skinTipLabel('creator', null), {
    name: 'Support my work Give, tip or appreciate',
    lines: ['Support my work', 'Give, tip or appreciate'],
  });
});

test('every other skin keeps "Tip ₦…"', () => {
  for (const skin of [
    'clear',
    'journal',
    'stage',
    'signboard',
    'sprint',
    'tiles',
    'linen',
    'horizon',
  ]) {
    assert.equal(skinTipLabel(skin, '200000'), null, skin);
    assert.equal(skinTipLabel(skin, null), null, skin);
  }
});
