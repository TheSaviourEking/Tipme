import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_DEFAULT_FONTS,
  STUDIO_FONTS,
  STUDIO_REQUIRED_CODEPOINTS,
  STUDIO_SPACING,
  fontsOk,
  studioTypeScale,
} from '../dist/index.js';

const STEPS = ['compact', 'standard', 'roomy'];
const ROLES = ['small', 'body', 'h3', 'h2', 'display'];
const px = (css, viewport) => {
  // clamp(MINpx, calc(Arem + Bvw), MAXpx) or clamp(MINpx, Arem + Bvw, MAXpx)
  const m =
    /^clamp\(([\d.]+)px, (?:calc\()?([\d.]+)rem \+ ([\d.]+)vw\)?, ([\d.]+)px\)$/.exec(
      css,
    );
  assert.ok(m, css);
  const [min, rem, vw, max] = m.slice(1).map(Number);
  return Math.min(max, Math.max(min, rem * 16 + (vw * viewport) / 100));
};

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

test('each family is at most two files and each file carries its weights', () => {
  for (const f of STUDIO_FONTS) {
    assert.ok(f.files.length >= 1 && f.files.length <= 2, f.id);
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

test('type scale: body ≥ 16, small ≥ 13, display at 320px ≤ 40, steps strictly increase', () => {
  for (const step of STEPS) {
    const s = studioTypeScale(step);
    assert.deepEqual(Object.keys(s).sort(), [...ROLES].sort());
    assert.equal(s.body.min, 16);
    assert.ok(s.small.min >= 13, `${step} small ${s.small.min}`);
    assert.ok(px(s.display.css, 320) <= 40, `${step} display at 320`);
    for (const viewport of [320, 390, 768, 1024, 1440]) {
      const sizes = ROLES.map((r) => px(s[r].css, viewport));
      for (let i = 1; i < sizes.length; i += 1)
        assert.ok(
          sizes[i] > sizes[i - 1],
          `${step} ${ROLES[i]} at ${viewport}`,
        );
      assert.ok(px(s.body.css, viewport) >= 16);
      assert.ok(px(s.small.css, viewport) >= 13);
    }
    for (const r of ROLES) {
      assert.ok(s[r].min <= s[r].max, `${step} ${r}`);
      assert.ok(
        Math.abs(px(s[r].css, 320) - s[r].min) < 0.02,
        `${step} ${r} at 320`,
      );
      assert.ok(
        Math.abs(px(s[r].css, 1440) - s[r].max) < 0.02,
        `${step} ${r} at 1440`,
      );
    }
    assert.equal(s.body.measure, '68ch');
    assert.equal(s.body.lineHeight, 1.6);
    assert.equal(s.display.lineHeight, 1.1);
  }
  assert.equal(
    studioTypeScale('standard').body.css,
    'clamp(16px, 0.95rem + 0.25vw, 18px)',
  );
});

test('larger steps make larger headings', () => {
  const at = (step) => px(studioTypeScale(step).h2.css, 1440);
  assert.ok(at('compact') < at('standard') && at('standard') < at('roomy'));
});

test('spacing steps are fixed', () => {
  assert.deepEqual(STUDIO_SPACING, {
    s: { min: 16, max: 24 },
    m: { min: 24, max: 48 },
    l: { min: 40, max: 80 },
  });
});

test('fontsOk refuses a display font as body and allows one family for both', () => {
  const display = STUDIO_FONTS.find((f) => f.category === 'display');
  const both = STUDIO_FONTS.find((f) => f.roles.includes('body'));
  assert.equal(fontsOk(display.id, display.id), false);
  assert.equal(fontsOk(both.id, display.id), false);
  assert.equal(fontsOk(display.id, both.id), true);
  assert.equal(fontsOk(both.id, both.id), true);
  assert.equal(fontsOk('comic-sans', both.id), false);
  assert.equal(
    fontsOk(STUDIO_DEFAULT_FONTS.heading, STUDIO_DEFAULT_FONTS.body),
    true,
  );
  assert.equal(STUDIO_DEFAULT_FONTS.heading, 'manrope');
});
