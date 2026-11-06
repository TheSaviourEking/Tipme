import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHARE_CAP_BPS,
  SHARE_NOTICE_DAYS,
  SHARE_OPTIONS_BPS,
  lagosDateOf,
  lagosMonthOf,
  shareStartsAt,
  splitEqually,
  splitShare,
} from '../dist/index.js';

// Business release 2 (plan R2-0 Task 27): the share and team-split arithmetic every later PR uses.

test('the share options are the owner’s, capped at 50%, with 14 days’ notice', () => {
  assert.deepEqual([...SHARE_OPTIONS_BPS], [0, 1000, 2000, 3000, 5000]);
  assert.equal(SHARE_CAP_BPS, 5000);
  assert.ok(SHARE_OPTIONS_BPS.every((bps) => bps <= SHARE_CAP_BPS));
  assert.equal(SHARE_NOTICE_DAYS, 14);
});

test('splitShare: 90/10 of 1,801 kobo net gives the person 1,621 and the business 180 (share rounded down)', () => {
  assert.deepEqual(splitShare(1801n, 1000), {
    personMinor: 1621n,
    businessMinor: 180n,
  });
});

test('splitShare: every option adds up to the net, and the person never gets less than half', () => {
  for (const net of [1n, 2n, 3n, 999n, 180_000n, 450_001n])
    for (const bps of SHARE_OPTIONS_BPS) {
      const { personMinor, businessMinor } = splitShare(net, bps);
      assert.equal(personMinor + businessMinor, net);
      assert.ok(businessMinor >= 0n);
      assert.ok(personMinor * 2n >= net, `${net} at ${bps}`);
    }
  assert.deepEqual(splitShare(1801n, 0), {
    personMinor: 1801n,
    businessMinor: 0n,
  });
  // 50/50 of an odd amount: the remainder kobo stays with the person.
  assert.deepEqual(splitShare(3n, 5000), {
    personMinor: 2n,
    businessMinor: 1n,
  });
});

test('splitShare refuses bps outside the options and above 5000', () => {
  for (const bps of [-1000, 500, 1500, 4000, 6000, 10000, 1000.5, NaN])
    assert.throws(() => splitShare(1801n, bps), RangeError, String(bps));
  assert.throws(() => splitShare(0n, 1000), RangeError);
  assert.throws(() => splitShare(-5n, 1000), RangeError);
});

test('splitEqually: 1,000 kobo among 3 gives 334, 333, 333 (first takes the remainder)', () => {
  assert.deepEqual(splitEqually(1000n, 3), [334n, 333n, 333n]);
  assert.deepEqual(splitEqually(1000n, 1), [1000n]);
  assert.deepEqual(splitEqually(1001n, 4), [251n, 250n, 250n, 250n]);
});

test('splitEqually always adds up and every part is at least 1 kobo', () => {
  for (const total of [7n, 100n, 180_001n])
    for (let n = 1; n <= 7; n++) {
      const parts = splitEqually(total, n);
      assert.equal(parts.length, n);
      assert.equal(
        parts.reduce((sum, part) => sum + part, 0n),
        total,
      );
      assert.ok(parts.every((part) => part >= 1n));
      // The first part carries the whole remainder (M17), so it is ahead by less than n kobo.
      assert.ok(parts[0] - parts[n - 1] < BigInt(n));
    }
});

test('splitEqually refuses nobody, a fraction of a person, or less than a kobo each', () => {
  assert.throws(() => splitEqually(1000n, 0), RangeError);
  assert.throws(() => splitEqually(1000n, 1.5), RangeError);
  assert.throws(() => splitEqually(2n, 3), RangeError);
  assert.throws(() => splitEqually(0n, 1), RangeError);
});

// PR R2-C1: when a proposed split starts, and which calendar month a change falls in (M15).

test('shareStartsAt: the first Lagos midnight at least 14 days on', () => {
  // 6 Nov 2026 15:00 Lagos (14:00 UTC): 14 days on is 20 Nov 15:00, so it starts 21 Nov 00:00 Lagos.
  const start = shareStartsAt(new Date('2026-11-06T14:00:00Z'));
  assert.equal(start.toISOString(), '2026-11-20T23:00:00.000Z');
  assert.equal(lagosDateOf(start), '2026-11-21');
  // Exactly at a Lagos midnight: 14 days on is itself a midnight, so it starts then.
  const atMidnight = shareStartsAt(new Date('2026-11-05T23:00:00Z'));
  assert.equal(atMidnight.toISOString(), '2026-11-19T23:00:00.000Z');
  // Always at least the notice, whatever the hour.
  for (let hour = 0; hour < 48; hour += 1) {
    const now = new Date(Date.UTC(2026, 11, 30, hour, 17));
    const at = shareStartsAt(now);
    assert.ok(at.getTime() - now.getTime() >= SHARE_NOTICE_DAYS * 86_400_000);
    assert.ok(
      at.getTime() - now.getTime() < (SHARE_NOTICE_DAYS + 1) * 86_400_000,
    );
    assert.equal(
      (at.getTime() + 3_600_000) % 86_400_000,
      0,
      'a Lagos midnight',
    );
  }
});

test('lagosMonthOf and lagosDateOf read the Lagos calendar, not UTC', () => {
  // 30 Nov 23:30 UTC is already 1 December in Lagos.
  const at = new Date('2026-11-30T23:30:00Z');
  assert.equal(lagosMonthOf(at), '2026-12');
  assert.equal(lagosDateOf(at), '2026-12-01');
  assert.equal(lagosMonthOf(new Date('2026-11-30T22:59:59Z')), '2026-11');
});
