import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announce } from '../src/lib/tip-announcement.ts';

const tip = (id, from = 'Chidi') => ({
  id,
  kind: 'tip',
  tipId: id,
  momentId: null,
  reportId: null,
  title: 'You got a tip',
  body: `NGN 1,800.00 from ${from}`,
  read: false,
  createdAt: '2026-11-05T12:00:00Z',
});
const news = (id) => ({
  ...tip(id),
  kind: 'weekly_report',
  tipId: null,
  title: 'Your week is ready',
  body: 'See how it went',
});
const START = { lastAt: null, heldCount: 0 };
const shown = { hideDetails: false };

test('a new tip announces title and body', () => {
  const { text, state } = announce(START, [tip('a')], 1000, shown);
  assert.equal(text, 'You got a tip · NGN 1,800.00 from Chidi');
  assert.deepEqual(state, { lastAt: 1000, heldCount: 0 });
});

test('with hideDetails the text is exactly "You got a new tip"', () => {
  assert.equal(
    announce(START, [tip('a')], 0, { hideDetails: true }).text,
    'You got a new tip',
  );
});

test('a second tip within 60 s is held, and the next announcement after the minute is "2 new tips"', () => {
  let r = announce(START, [tip('a')], 0, shown);
  r = announce(r.state, [tip('b')], 30_000, shown);
  assert.equal(r.text, null);
  assert.deepEqual(r.state, { lastAt: 0, heldCount: 1 });
  r = announce(r.state, [tip('c')], 70_000, shown);
  assert.equal(r.text, '2 new tips');
  assert.deepEqual(r.state, { lastAt: 70_000, heldCount: 0 });
});

test('held tips are announced at the minute even if nothing else arrives', () => {
  let r = announce(START, [tip('a')], 0, shown);
  r = announce(r.state, [tip('b'), tip('c')], 10_000, shown);
  assert.equal(r.text, null);
  assert.equal(announce(r.state, [], 59_999, shown).text, null);
  r = announce(r.state, [], 60_000, shown);
  assert.equal(r.text, '2 new tips');
  assert.equal(
    announce(announce(START, [tip('a')], 0, shown).state, [tip('b')], 1, shown)
      .state.heldCount,
    1,
  );
  assert.equal(
    announce({ lastAt: 0, heldCount: 1 }, [], 60_000, { hideDetails: true })
      .text,
    '1 new tip',
  );
});

test('tips that arrive together are one count, never a name', () => {
  assert.equal(
    announce(START, [tip('a'), tip('b', 'Ada')], 0, shown).text,
    '2 new tips',
  );
});

test('a notification body is used, never a tip note', () => {
  const withNote = {
    ...tip('a'),
    note: 'Thank you for the music',
    message: 'secret',
  };
  const { text } = announce(START, [withNote], 0, shown);
  assert.equal(text, 'You got a tip · NGN 1,800.00 from Chidi');
  assert.ok(!text.includes('music') && !text.includes('secret'));
});

test('non-tip news keeps today’s title · body, and never interrupts within the minute', () => {
  assert.equal(
    announce(START, [news('r')], 0, shown).text,
    'Your week is ready · See how it went',
  );
  // With details hidden, other news still reads as it is: only tips carry a supporter and amount.
  assert.equal(
    announce(START, [news('r')], 0, { hideDetails: true }).text,
    'Your week is ready · See how it went',
  );
  const r = announce(
    announce(START, [tip('a')], 0, shown).state,
    [news('r')],
    5000,
    shown,
  );
  assert.equal(r.text, null);
  assert.equal(r.state.heldCount, 0);
});

test('nothing is announced on the first load', () => {
  // The bell passes no "fresh" notifications for the first read: nothing to say.
  const r = announce(START, [], 0, shown);
  assert.equal(r.text, null);
  assert.deepEqual(r.state, START);
});
