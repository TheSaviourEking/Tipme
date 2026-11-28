import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownTimerRuns } from '../src/lib/own-timer.ts';

// A screen keeps its own timer only when no live connection covers it: no provider or no
// EventSource ('idle'), or live updates turned off ('disabled'). Connecting, connected and the
// client's own fallback poll ('polling') all mean the stream's reads cover the screen.
test('only idle and disabled run their own timer', () => {
  const expected = {
    idle: true,
    disabled: true,
    connecting: false,
    connected: false,
    polling: false,
  };
  for (const [status, runs] of Object.entries(expected))
    assert.equal(ownTimerRuns(status), runs, status);
});
