import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOIN_LINK_KEY,
  joinCodeFrom,
  keepJoinLink,
  takeJoinCode,
  clearJoinLink,
} from '../src/lib/business/join-link.ts';

// A minimal browser: the address bar's fragment, history and this tab's storage.
function browser(hash = '', { storageBlocked = false } = {}) {
  const store = new Map();
  const replaced = [];
  globalThis.location = { hash, pathname: '/dashboard/work', search: '' };
  globalThis.history = {
    replaceState: (_s, _t, url) => {
      replaced.push(url);
      globalThis.location.hash = '';
    },
  };
  globalThis.sessionStorage = {
    getItem: (k) => {
      if (storageBlocked) throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (storageBlocked) throw new Error('blocked');
      store.set(k, v);
    },
    removeItem: (k) => {
      if (storageBlocked) throw new Error('blocked');
      store.delete(k);
    },
  };
  return { store, replaced };
}

const CODE = 'ABCDEFGHJKMNPQ23';

test('a join link is a fragment with a 16-character code; anything else is not one', () => {
  assert.equal(joinCodeFrom(`#join=${CODE}`), CODE);
  assert.equal(joinCodeFrom(`#join=${CODE.toLowerCase()}`), CODE);
  for (const hash of [
    '',
    '#join=',
    '#join=SHORT',
    '#enrol=ABCDEFGHJKMNPQ23',
    `#join=${CODE}X`,
    '#join=ABCDEFGHJKMNPQ01',
  ])
    assert.equal(joinCodeFrom(hash), null, hash);
});

test('a sign-in that interrupts the link keeps it in this tab, and coming back finds it', () => {
  const { store } = browser(`#join=${CODE}`);
  keepJoinLink();
  assert.equal(store.get(JOIN_LINK_KEY), `#join=${CODE}`);
  // Back from sign-in: the fragment is gone, the tab still has it.
  globalThis.location.hash = '';
  assert.equal(takeJoinCode(), CODE);
});

test('the address bar wins over what the tab kept, and clearing takes it out of both', () => {
  const other = 'ZZZZZZZZZZZZZZZZ';
  const { store, replaced } = browser(`#join=${other}`);
  store.set(JOIN_LINK_KEY, `#join=${CODE}`);
  assert.equal(takeJoinCode(), other);
  clearJoinLink();
  assert.deepEqual(replaced, ['/dashboard/work']);
  assert.equal(store.has(JOIN_LINK_KEY), false);
  assert.equal(takeJoinCode(), null);
});

test('nothing is kept when the fragment is not a join link, and blocked storage is harmless', () => {
  const { store } = browser('#recovery');
  keepJoinLink();
  assert.equal(store.size, 0);
  browser(`#join=${CODE}`, { storageBlocked: true });
  keepJoinLink();
  assert.equal(takeJoinCode(), CODE);
  clearJoinLink();
});
