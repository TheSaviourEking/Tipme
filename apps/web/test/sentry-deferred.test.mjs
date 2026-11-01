import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  captureDeferredException,
  deferSentry,
} from '../src/lib/deferred-sentry.ts';

const instrumentation = readFileSync(
  new URL('../src/instrumentation-client.ts', import.meta.url),
  'utf8',
);
const globalError = readFileSync(
  new URL('../src/app/global-error.tsx', import.meta.url),
  'utf8',
);

function fakeWindow(readyState = 'loading') {
  const listeners = new Map();
  return {
    document: { readyState },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('the client instrumentation dynamically imports Sentry', () => {
  assert.doesNotMatch(
    instrumentation,
    /import\s+\*\s+as\s+Sentry\s+from\s+['"]@sentry\/nextjs['"]/,
  );
  assert.match(instrumentation, /import\(['"]@sentry\/nextjs['"]\)/);
  assert.doesNotMatch(
    globalError,
    /import\s+\*\s+as\s+Sentry\s+from\s+['"]@sentry\/nextjs['"]/,
  );
});

test('Sentry loads after page load and replays early browser errors', async () => {
  const browser = fakeWindow();
  const idleCallbacks = [];
  const errors = [];
  const transitions = [];
  let loads = 0;
  const sentry = deferSentry(
    async () => {
      loads += 1;
      return {
        captureException: (error) => errors.push(error),
        captureRouterTransitionStart: (...args) => transitions.push(args),
      };
    },
    browser,
    (callback) => idleCallbacks.push(callback),
  );

  browser.dispatch('error', { error: new Error('early error') });
  browser.dispatch('unhandledrejection', { reason: 'early rejection' });
  captureDeferredException(new Error('error-boundary failure'));
  sentry.onRouterTransitionStart('/first-route', 'push');
  assert.equal(loads, 0);

  browser.dispatch('load');
  assert.equal(loads, 0);
  assert.equal(idleCallbacks.length, 1);
  idleCallbacks[0]();
  await flushMicrotasks();

  assert.equal(loads, 1);
  assert.equal(errors.length, 3);
  assert.equal(errors[0].message, 'early error');
  assert.equal(errors[1], 'early rejection');
  assert.equal(errors[2].message, 'error-boundary failure');
  sentry.onRouterTransitionStart('/next-route', 'push');
  assert.deepEqual(transitions, [['/next-route', 'push']]);
});

test('Sentry initializes when instrumentation runs after the window load event', async () => {
  const browser = fakeWindow('complete');
  const idleCallbacks = [];
  let loads = 0;
  deferSentry(
    async () => {
      loads += 1;
      return {
        captureException() {},
        captureRouterTransitionStart() {},
      };
    },
    browser,
    (callback) => idleCallbacks.push(callback),
  );

  assert.equal(loads, 0);
  assert.equal(idleCallbacks.length, 1);
  idleCallbacks[0]();
  await flushMicrotasks();
  assert.equal(loads, 1);
});

test('a failed Sentry load is reported without leaking the import error', async () => {
  const browser = fakeWindow();
  const idleCallbacks = [];
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    deferSentry(
      async () => {
        throw new Error('sensitive import detail');
      },
      browser,
      (callback) => idleCallbacks.push(callback),
    );
    browser.dispatch('load');
    idleCallbacks[0]();
    await flushMicrotasks();
    assert.deepEqual(warnings, [
      'Client error monitoring could not be initialized.',
    ]);
  } finally {
    console.warn = warn;
  }
});
