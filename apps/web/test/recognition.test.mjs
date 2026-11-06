import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPendingTip } from '../src/lib/pending-tip.ts';
import {
  forgetMyTips,
  lastAtBusiness,
  readMyTips,
  recognitionMessage,
  rememberTip,
} from '../src/lib/recognition.ts';

const KEY = 'tipme.myTips.v1';
function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
}
const tip = (id, handle) => ({ id, handle, at: '2026-10-18T10:00:00.000Z' });

test('the same tip is remembered once', () => {
  const storage = memoryStorage();
  assert.deepEqual(rememberTip(storage, tip('a', 'ada')), {
    count: 1,
    people: 1,
  });
  assert.deepEqual(rememberTip(storage, tip('a', 'ada')), {
    count: 1,
    people: 1,
  });
});

test('counts tips and the distinct people tipped', () => {
  const storage = memoryStorage();
  rememberTip(storage, tip('a', 'ada'));
  rememberTip(storage, tip('b', 'tobi'));
  assert.deepEqual(rememberTip(storage, tip('c', 'Ada')), {
    count: 3,
    people: 2,
  });
});

test('only the id, handle and time are stored', () => {
  const storage = memoryStorage();
  rememberTip(storage, {
    ...tip('a', 'ada'),
    amountMinor: '100000',
    message: 'hi',
  });
  const stored = JSON.parse(storage.getItem(KEY));
  assert.equal(stored.v, 1);
  assert.deepEqual(Object.keys(stored.tips[0]).sort(), ['at', 'handle', 'id']);
});

test('the record is capped', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 510; i += 1) rememberTip(storage, tip(`t${i}`, 'ada'));
  assert.equal(readMyTips(storage).tips.length, 500);
});

test('minor: totals keep counting after the record is capped', () => {
  const storage = memoryStorage();
  let totals;
  for (let i = 0; i < 520; i += 1)
    totals = rememberTip(
      storage,
      tip(`t${i}`, i < 260 ? 'ada' : `person${i % 3}`),
    );
  assert.deepEqual(totals, { count: 520, people: 4 });
  // A replay is always a recent tip (the one on screen), which is still in the record.
  assert.deepEqual(rememberTip(storage, tip('t519', 'person0')), {
    count: 520,
    people: 4,
  });
  assert.equal(
    recognitionMessage(rememberTip(storage, tip('t999', 'tobi'))).startsWith(
      "That's your 521st tip.",
    ),
    true,
  );
});

test('minor: older records without totals still count correctly', () => {
  const storage = memoryStorage();
  storage.setItem(
    'tipme.myTips.v1',
    JSON.stringify({ v: 1, tips: [tip('a', 'ada'), tip('b', 'tobi')] }),
  );
  assert.deepEqual(rememberTip(storage, tip('c', 'ada')), {
    count: 3,
    people: 2,
  });
});

test('recognition copy celebrates and never compares', () => {
  assert.equal(
    recognitionMessage({ count: 12, people: 5 }),
    "That's your 12th tip. You've made 5 people's day. We see you.",
  );
  assert.equal(
    recognitionMessage({ count: 1, people: 1 }),
    "That's your first tip. You've made someone's day. We see you.",
  );
  assert.equal(
    recognitionMessage({ count: 2, people: 1 }),
    "That's your 2nd tip. You've made 1 person's day. We see you.",
  );
  assert.equal(
    recognitionMessage({ count: 3, people: 2 }).startsWith(
      "That's your 3rd tip.",
    ),
    true,
  );
  assert.equal(
    recognitionMessage({ count: 11, people: 2 }).startsWith(
      "That's your 11th tip.",
    ),
    true,
  );
  assert.equal(
    recognitionMessage({ count: 22, people: 2 }).startsWith(
      "That's your 22nd tip.",
    ),
    true,
  );
});

test('corrupt, foreign or huge records are ignored without throwing', () => {
  for (const value of [
    '{not json',
    JSON.stringify({ v: 2, tips: [] }),
    'x'.repeat(1_000_000),
    JSON.stringify({ v: 1, tips: [{ id: 1 }] }),
    JSON.stringify({ v: 1, tips: 'nope' }),
    'null',
  ]) {
    const storage = memoryStorage();
    storage.setItem(KEY, value);
    assert.deepEqual(readMyTips(storage), { tips: [] });
    assert.deepEqual(rememberTip(storage, tip('a', 'ada')), {
      count: 1,
      people: 1,
    });
  }
  assert.deepEqual(readMyTips(undefined), { tips: [] });
  const throwing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  assert.deepEqual(readMyTips(throwing), { tips: [] });
  assert.deepEqual(rememberTip(throwing, tip('a', 'ada')), {
    count: 1,
    people: 1,
  });
  assert.doesNotThrow(() => forgetMyTips(throwing));
});

test('forgetting clears the record', () => {
  const storage = memoryStorage();
  rememberTip(storage, tip('a', 'ada'));
  forgetMyTips(storage);
  assert.deepEqual(readMyTips(storage), { tips: [] });
});

// TipMe for businesses, PR B4 (M8): the last person tipped at a business, kept only when the
// supporter ticked "Remember my tips on this phone", in this browser only.
test('a tip made at a business remembers the business; lastAtBusiness names the latest person there', () => {
  const storage = memoryStorage();
  assert.equal(lastAtBusiness(storage, 'yellow-chilli'), null);
  rememberTip(storage, { ...tip('a', 'tobi'), business: 'yellow-chilli' });
  rememberTip(storage, tip('b', 'ada'));
  rememberTip(storage, { ...tip('c', 'kemi'), business: 'other-place' });
  assert.equal(lastAtBusiness(storage, 'yellow-chilli')?.handle, 'tobi');
  rememberTip(storage, { ...tip('d', 'amaka'), business: 'yellow-chilli' });
  assert.equal(lastAtBusiness(storage, 'yellow-chilli')?.handle, 'amaka');
  assert.equal(lastAtBusiness(storage, 'Yellow-Chilli')?.handle, 'amaka');
  assert.equal(lastAtBusiness(storage, 'nowhere'), null);
  // Plain tips still read as before, and a record from before businesses still reads.
  assert.equal(readMyTips(storage).tips.length, 4);
  const old = memoryStorage();
  old.setItem(KEY, JSON.stringify({ v: 1, tips: [tip('a', 'ada')] }));
  assert.equal(readMyTips(old).tips.length, 1);
  assert.equal(lastAtBusiness(old, 'yellow-chilli'), null);
  // A tampered business slug makes the record foreign, as any bad field does.
  const bad = memoryStorage();
  bad.setItem(
    KEY,
    JSON.stringify({ v: 1, tips: [{ ...tip('a', 'ada'), business: 7 }] }),
  );
  assert.deepEqual(readMyTips(bad), { tips: [] });
  assert.equal(lastAtBusiness(undefined, 'yellow-chilli'), null);
});

test('the pending tip carries the business it was made at, or none', () => {
  const session = memoryStorage();
  session.setItem(
    'tipme.pending.t1',
    JSON.stringify({ optIn: true, handle: 'tobi', business: 'yellow-chilli' }),
  );
  session.setItem(
    'tipme.pending.t2',
    JSON.stringify({ optIn: false, handle: 'ada' }),
  );
  session.setItem(
    'tipme.pending.t3',
    JSON.stringify({ optIn: true, handle: 'ada', business: 'Not A Slug!' }),
  );
  assert.deepEqual(readPendingTip(session, 't1'), {
    optIn: true,
    handle: 'tobi',
    business: 'yellow-chilli',
  });
  assert.deepEqual(readPendingTip(session, 't2'), {
    optIn: false,
    handle: 'ada',
    business: null,
  });
  assert.equal(readPendingTip(session, 't3').business, null);
  assert.deepEqual(readPendingTip(session, 'none'), {
    optIn: false,
    handle: null,
    business: null,
  });
});
