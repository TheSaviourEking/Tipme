import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextProviderDeadline } from '../src/lib/provider-deadline.ts';

// A resting provider turns "trial" when its `until` passes, with no write and so no signal
// (addendum §3.3). While connected, the Providers page sets one timeout for the earliest future
// `until`, plus up to 5 s of jitter so many open pages don't read at the same instant.

const NOW = Date.parse('2026-11-26T10:00:00Z');
const at = (ms) => new Date(NOW + ms).toISOString();
const card = (health) => ({ name: 'mock', health });
const resting = (until) => ({
  state: 'resting',
  kind: 'send',
  until,
  reason: '3 send failures in 5 min (last: http_503)',
  trippedAt: at(-60_000),
});

test('the earliest future until wins', () => {
  const providers = [
    card(resting(at(90_000))),
    card(resting(at(30_000))),
    card(resting(at(60_000))),
  ];
  assert.equal(
    nextProviderDeadline(providers, NOW, () => 0),
    30_000,
  );
  // A past one beside them never wins.
  assert.equal(
    nextProviderDeadline(
      [card(resting(at(-1000))), ...providers],
      NOW,
      () => 0,
    ),
    30_000,
  );
});

test('a past until or no health gives null', () => {
  assert.equal(
    nextProviderDeadline([], NOW, () => 0),
    null,
  );
  assert.equal(
    nextProviderDeadline([card(null)], NOW, () => 0),
    null,
  );
  assert.equal(
    nextProviderDeadline(
      [
        card({ ...resting(null), state: 'trial' }),
        card({ ...resting(null), state: 'healthy' }),
      ],
      NOW,
      () => 0,
    ),
    null,
  );
  assert.equal(
    nextProviderDeadline([card(resting(at(-1)))], NOW, () => 0),
    null,
  );
  // Exactly now has passed too: reading now would show what the page already shows.
  assert.equal(
    nextProviderDeadline([card(resting(at(0)))], NOW, () => 0),
    null,
  );
  // Unreadable is never a deadline.
  assert.equal(
    nextProviderDeadline([card(resting('not a date'))], NOW, () => 0),
    null,
  );
});

test('jitter stays under 5 s', () => {
  const providers = [card(resting(at(8000)))];
  assert.equal(
    nextProviderDeadline(providers, NOW, () => 0.5),
    10_500,
  );
  // random() is below 1, so the jitter is below 5000.
  const highest = nextProviderDeadline(providers, NOW, () => 0.999_999);
  assert.ok(
    highest !== null && highest >= 8000 && highest < 13_000,
    String(highest),
  );
  for (let i = 0; i < 200; i += 1) {
    const ms = nextProviderDeadline(providers, NOW, Math.random);
    assert.ok(ms !== null && ms >= 8000 && ms < 13_000, String(ms));
  }
});

// Browsers fire a setTimeout longer than 2^31 - 1 ms at once, and each read then re-arms it: a
// request loop. A far-off `until` (the rest setting has no upper bound) waits the most a timer can.
test('a deadline more than ~24.8 days away is capped at the longest timer', () => {
  const MAX_TIMER_MS = 2_147_483_647;
  const far = [card(resting(at(30 * 24 * 60 * 60 * 1000)))];
  assert.equal(
    nextProviderDeadline(far, NOW, () => 0.5),
    MAX_TIMER_MS,
  );
  // Just under the cap is left as it is.
  const near = [card(resting(at(MAX_TIMER_MS - 10_000)))];
  assert.equal(
    nextProviderDeadline(near, NOW, () => 0),
    MAX_TIMER_MS - 10_000,
  );
});
