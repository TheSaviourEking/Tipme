import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareableWeek } from '../src/lib/week-share.ts';

const report = {
  week: '2026-W41',
  totalNetMinor: '654500',
  changePct: 600,
  tipCount: 4,
  notesCount: 1,
  bestDay: { date: '2026-10-07', netMinor: '374000' },
  topSupporterLabel: 'Zed Q.',
  moments: [{ key: 'milestone.10.x', title: '10 tips!' }],
};

test('the shareable week never carries a supporter’s name', () => {
  const shared = shareableWeek(report, {
    displayName: 'Tobi Adeyemi',
    handle: 'tobi',
  });
  assert.equal(JSON.stringify(shared).includes('Zed'), false);
  assert.deepEqual(Object.keys(shared).sort(), [
    'changeText',
    'displayName',
    'handle',
    'moments',
    'tipCount',
    'total',
    'week',
  ]);
  assert.equal(shared.total, 'NGN 6,545.00');
  assert.equal(shared.changeText, '▲ 600% on the week before');
  assert.deepEqual(shared.moments, ['10 tips!']);
});

test('a first week shows no comparison', () => {
  const shared = shareableWeek(
    { ...report, changePct: null },
    { displayName: 'Kemi', handle: 'kemi' },
  );
  assert.equal(shared.changeText, null);
});
