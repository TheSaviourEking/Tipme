import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTipSound } from '../src/lib/tip-sound.ts';

function harness({ reject = false } = {}) {
  const plays = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
    }
    play() {
      plays.push({ src: this.src, volume: this.volume });
      return reject
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve();
    }
  }
  const listeners = {};
  const doc = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };
  const sound = createTipSound({
    src: '/sounds/new-tip.wav',
    volume: 0.35,
    Audio: FakeAudio,
    document: doc,
  });
  return {
    sound,
    plays,
    doc,
    interact(type = 'pointerdown') {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

test('it plays only when hidden, enabled, armed and the notification is a paid tip', () => {
  const h = harness();
  h.doc.visibilityState = 'hidden';
  h.sound.play({ enabled: true, isPaidTip: true });
  assert.equal(h.plays.length, 0, 'not armed: no interaction yet');
  h.interact('keydown');
  assert.equal(h.sound.armed, true);
  h.sound.play({ enabled: false, isPaidTip: true });
  h.sound.play({ enabled: true, isPaidTip: false });
  h.doc.visibilityState = 'visible';
  h.sound.play({ enabled: true, isPaidTip: true });
  assert.equal(h.plays.length, 0);
  h.doc.visibilityState = 'hidden';
  h.sound.play({ enabled: true, isPaidTip: true });
  assert.deepEqual(h.plays, [{ src: '/sounds/new-tip.wav', volume: 0.35 }]);
});

test('a rejected play() is swallowed and nothing is shown', async () => {
  const h = harness({ reject: true });
  h.interact();
  h.doc.visibilityState = 'hidden';
  let unhandled = 0;
  const onUnhandled = () => (unhandled += 1);
  process.on('unhandledRejection', onUnhandled);
  assert.doesNotThrow(() => h.sound.play({ enabled: true, isPaidTip: true }));
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(h.plays.length, 1);
});

test('it never plays for a non-tip notification', () => {
  const h = harness();
  h.interact();
  h.doc.visibilityState = 'hidden';
  h.sound.play({ enabled: true, isPaidTip: false });
  assert.equal(h.plays.length, 0);
});

test('reduced motion has no bearing on it', () => {
  const original = globalThis.matchMedia;
  let asked = 0;
  globalThis.matchMedia = () => {
    asked += 1;
    return { matches: true };
  };
  try {
    const h = harness();
    h.interact();
    h.doc.visibilityState = 'hidden';
    h.sound.play({ enabled: true, isPaidTip: true });
    assert.equal(h.plays.length, 1);
    assert.equal(asked, 0);
  } finally {
    globalThis.matchMedia = original;
  }
});
