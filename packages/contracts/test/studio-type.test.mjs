import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_FONTS,
  STUDIO_REQUIRED_CODEPOINTS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
} from '../dist/index.js';

test('display fonts are heading-only', () => {
  for (const f of STUDIO_FONTS)
    if (f.category === 'display') assert.deepEqual(f.roles, ['heading'], f.id);
});

test('ids are unique and every font has at least the heading role', () => {
  assert.equal(
    new Set(STUDIO_FONTS.map((f) => f.id)).size,
    STUDIO_FONTS.length,
  );
  for (const f of STUDIO_FONTS) assert.ok(f.roles.includes('heading'), f.id);
});

test('a body font draws every required letter, so it never needs the word fallback', () => {
  for (const f of STUDIO_FONTS)
    if (f.roles.includes('body')) {
      assert.equal(f.wordFallback, false, f.id);
      assert.ok(f.bodyWeight, `${f.id} has no body weight`);
    }
});

test('the registry is the faces the styles use (the v1 editor’s other fonts were retired in PR 4b)', () => {
  // Inter sets every UI, body and money face; each style adds at most its own display face.
  const used = new Set([
    'inter',
    ...STUDIO_STYLE_IDS.map((s) => STUDIO_STYLES[s].displayFont).filter(
      Boolean,
    ),
  ]);
  assert.deepEqual(STUDIO_FONTS.map((f) => f.id).sort(), [...used].sort());
  assert.deepEqual(STUDIO_FONTS.map((f) => f.id).sort(), [
    'anton',
    'dm-serif-display',
    'inter',
    'linen-serif',
    'source-serif-4',
    'unbounded',
  ]);
});

test('each family is at most two files and each file carries its weights', () => {
  for (const f of STUDIO_FONTS) {
    assert.ok(f.files.length >= 1 && f.files.length <= 3, f.id);
    const weights = f.files.flatMap((file) => {
      const [lo, hi = lo] = file.weight.split(' ').map(Number);
      return [[lo, hi]];
    });
    const covers = (w) => weights.some(([lo, hi]) => w >= lo && w <= hi);
    assert.ok(covers(f.headingWeight), `${f.id} heading ${f.headingWeight}`);
    if (f.bodyWeight)
      assert.ok(covers(f.bodyWeight), `${f.id} body ${f.bodyWeight}`);
    for (const file of f.files)
      assert.match(file.path, /^\/fonts\/studio\/[a-z0-9-]+\.woff2$/);
  }
});

test('metric-matched fallbacks: Arial for sans and rounded, Georgia for serif', () => {
  for (const f of STUDIO_FONTS) {
    if (f.category === 'serif')
      assert.equal(f.fallback.family, 'Georgia', f.id);
    if (f.category === 'sans' || f.category === 'rounded')
      assert.equal(f.fallback.family, 'Arial', f.id);
    for (const v of [
      f.fallback.sizeAdjust,
      f.fallback.ascentOverride,
      f.fallback.descentOverride,
    ])
      assert.match(v, /^\d+(\.\d+)?%$/, f.id);
    assert.ok(f.metrics.unitsPerEm > 0 && f.metrics.avgAdvance > 0, f.id);
    assert.ok(f.metrics.maxWordAdvance >= f.metrics.avgAdvance, f.id);
  }
});

test('the required characters cover Yoruba and Igbo letters, tone marks and the naira sign', () => {
  const has = (c) => STUDIO_REQUIRED_CODEPOINTS.includes(c);
  for (const ch of 'AZaz09ÀéñẸẹỌọṢṣỊịỤụṄṅ₦’“”–—…')
    assert.ok(has(ch.codePointAt(0)), ch);
  for (const mark of [0x300, 0x301, 0x304, 0x323])
    assert.ok(has(mark), mark.toString(16));
  assert.equal(has(0xad), false, 'the soft hyphen is never drawn');
  assert.equal(
    new Set(STUDIO_REQUIRED_CODEPOINTS).size,
    STUDIO_REQUIRED_CODEPOINTS.length,
  );
});

test('the required characters cover the Hausa hooked letters', () => {
  for (const c of [0x253, 0x257, 0x199, 0x1b4, 0x181, 0x18a, 0x198, 0x1b3])
    assert.ok(
      STUDIO_REQUIRED_CODEPOINTS.includes(c),
      `U+${c.toString(16).toUpperCase().padStart(4, '0')}`,
    );
});

test('the style faces are registered with their files', () => {
  const font = (id) => STUDIO_FONTS.find((f) => f.id === id);
  for (const id of ['unbounded', 'anton', 'linen-serif'])
    assert.ok(font(id), id);
  const linen = font('linen-serif');
  assert.equal(linen.files.length, 3);
  assert.ok(linen.files.some((file) => file.style === 'italic'));
  assert.deepEqual(
    linen.files.map((file) => `${file.weight} ${file.style}`).sort(),
    ['400 italic', '400 normal', '700 normal'],
  );
  const serif = font('source-serif-4');
  assert.ok(serif.files.some((file) => file.style === 'italic'));
  assert.equal(serif.wordFallback, true);
  const [lo, hi] = font('inter').files[0].weight.split(' ').map(Number);
  assert.ok(lo <= 400 && hi >= 800, 'Inter spans 400 to 800');
});
