import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THANKS_LINE_LIMIT,
  THANKS_STYLES,
  apiErrorCodes,
  cleanThanksLine,
  hasLink,
  shownThanks,
  thanksNeedsPro,
  thanksPatchSchema,
} from '../dist/index.js';

test('cleanThanksLine removes control characters, collapses spaces and trims', () => {
  assert.equal(
    cleanThanksLine('  Thank\u0007 you\n\nso   much '),
    'Thank you so much',
  );
  assert.equal(cleanThanksLine('   '), '');
});

test('a line of 140 code points is accepted, 141 is refused, emoji count once', () => {
  assert.equal(THANKS_LINE_LIMIT, 140);
  assert.equal(
    thanksPatchSchema.safeParse({ line: '😀'.repeat(140) }).success,
    true,
  );
  const emoji = thanksPatchSchema.safeParse({ line: '😀'.repeat(141) });
  assert.equal(emoji.success, false);
  assert.deepEqual(emoji.error.issues[0].path, ['line']);
  assert.equal(
    thanksPatchSchema.safeParse({ line: 'a'.repeat(141) }).success,
    false,
  );
});

test('a line with a link is refused', () => {
  for (const line of [
    'see https://x.com',
    'www.me.ng',
    'tipme.xyz/@ada',
    'ada.com.ng',
  ]) {
    assert.equal(hasLink(line), true, line);
    const parsed = thanksPatchSchema.safeParse({ line });
    assert.equal(parsed.success, false, line);
    assert.deepEqual(parsed.error.issues[0].path, ['line']);
  }
  for (const line of ['Thanks a lot. See you soon!', 'No. 1 fan', 'Mr. Ade']) {
    assert.equal(hasLink(line), false, line);
    assert.equal(thanksPatchSchema.safeParse({ line }).success, true, line);
  }
});

test('null or an empty line clears it', () => {
  assert.deepEqual(thanksPatchSchema.parse({ line: null }), { line: null });
  assert.deepEqual(thanksPatchSchema.parse({ line: '   ' }), { line: null });
  assert.deepEqual(thanksPatchSchema.parse({ line: ' Thank  you ' }), {
    line: 'Thank you',
  });
});

test('unknown style and extra keys are refused', () => {
  assert.deepEqual([...THANKS_STYLES], ['paper', 'violet', 'night']);
  assert.equal(
    thanksPatchSchema.safeParse({ line: 'x', style: 'gold' }).success,
    false,
  );
  assert.equal(
    thanksPatchSchema.safeParse({ line: 'x', colour: 'red' }).success,
    false,
  );
  assert.equal(thanksPatchSchema.safeParse({ style: 'night' }).success, false);
  assert.equal(
    thanksPatchSchema.safeParse({ line: 'x', style: 'night', signed: true })
      .success,
    true,
  );
});

test('thanksNeedsPro: violet, night or signed: true', () => {
  assert.equal(thanksNeedsPro({}), false);
  assert.equal(thanksNeedsPro({ style: 'paper' }), false);
  assert.equal(thanksNeedsPro({ signed: false }), false);
  assert.equal(thanksNeedsPro({ style: 'violet' }), true);
  assert.equal(thanksNeedsPro({ style: 'night' }), true);
  assert.equal(thanksNeedsPro({ signed: true }), true);
});

const stored = { line: 'Thank you', style: 'night', signed: true };

test('shownThanks: Free shows the line on paper, unsigned, whatever is saved', () => {
  for (const plan of ['free', undefined])
    assert.deepEqual(
      shownThanks({ ...stored, plan, displayName: 'Ada Okafor' }),
      { line: 'Thank you', style: 'paper' },
    );
});

test('shownThanks: Pro shows its style and signs with the first name', () => {
  assert.deepEqual(
    shownThanks({ ...stored, plan: 'pro', displayName: 'Ada Okafor' }),
    { line: 'Thank you', style: 'night', signature: 'Ada' },
  );
  assert.deepEqual(
    shownThanks({
      line: 'Thank you',
      style: null,
      signed: false,
      plan: 'pro',
      displayName: 'Ada Okafor',
    }),
    { line: 'Thank you', style: 'paper' },
  );
  // A style the contract no longer knows reads as paper.
  assert.equal(
    shownThanks({ ...stored, style: 'gold', plan: 'pro', displayName: 'Ada' })
      .style,
    'paper',
  );
});

test('shownThanks: no line, no slip', () => {
  for (const plan of ['free', 'pro'])
    assert.equal(
      shownThanks({ ...stored, line: null, plan, displayName: 'Ada' }),
      null,
    );
});

test('THANKS_PRO_REQUIRED is an API error code', () => {
  assert.ok(apiErrorCodes.includes('THANKS_PRO_REQUIRED'));
});
