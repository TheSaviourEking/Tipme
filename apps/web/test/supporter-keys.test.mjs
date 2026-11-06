import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUPPORTER_KEYS,
  dropSupporterKey,
  forgetSupporterKeys,
  supporterKeyFor,
} from '../src/lib/supporter-keys.ts';

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}
const KEY = /^[A-Za-z0-9_-]{43}$/;

test('the store is tipme.supporters.v1', () => {
  assert.equal(SUPPORTER_KEYS, 'tipme.supporters.v1');
});

test('a key is made only with create=true, is stable per handle (case-insensitive) and differs between handles', () => {
  const storage = memoryStorage();
  assert.equal(supporterKeyFor(storage, 'Ada', false), null);
  assert.equal(storage.items.size, 0, 'asking without create writes nothing');
  const ada = supporterKeyFor(storage, 'Ada', true);
  assert.match(ada, KEY);
  assert.equal(supporterKeyFor(storage, 'ada', false), ada);
  assert.equal(supporterKeyFor(storage, 'ADA', true), ada);
  const tunde = supporterKeyFor(storage, 'tunde', true);
  assert.match(tunde, KEY);
  assert.notEqual(tunde, ada);
  const stored = JSON.parse(storage.items.get(SUPPORTER_KEYS));
  assert.deepEqual(stored, { v: 1, keys: { ada, tunde } });
});

test('keys are random: two fresh stores never share one', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1)
    seen.add(supporterKeyFor(memoryStorage(), 'ada', true));
  assert.equal(seen.size, 50);
});

test('drop removes one handle; forget removes them all', () => {
  const storage = memoryStorage();
  supporterKeyFor(storage, 'ada', true);
  const tunde = supporterKeyFor(storage, 'tunde', true);
  dropSupporterKey(storage, 'ADA');
  assert.equal(supporterKeyFor(storage, 'ada', false), null);
  assert.equal(supporterKeyFor(storage, 'tunde', false), tunde);
  forgetSupporterKeys(storage);
  assert.equal(storage.items.has(SUPPORTER_KEYS), false);
});

test('corrupt, foreign or oversized storage reads as empty; a full quota returns null and never throws', () => {
  for (const raw of [
    'not json',
    'null',
    '[]',
    JSON.stringify({ v: 2, keys: {} }),
    JSON.stringify({ v: 1, keys: { ada: 'short' } }),
    JSON.stringify({ v: 1, keys: { ada: 42 } }),
    JSON.stringify({ v: 1, keys: [] }),
    'x'.repeat(200_001),
  ]) {
    const storage = memoryStorage();
    storage.items.set(SUPPORTER_KEYS, raw);
    assert.equal(
      supporterKeyFor(storage, 'ada', false),
      null,
      raw.slice(0, 40),
    );
  }
  const full = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  // Not saved means not sent: a key the browser can't keep would make a new supporter every tip.
  assert.equal(supporterKeyFor(full, 'ada', true), null);
  assert.doesNotThrow(() => dropSupporterKey(full, 'ada'));
  assert.doesNotThrow(() => forgetSupporterKeys(full));
  const broken = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  assert.equal(supporterKeyFor(broken, 'ada', true), null);
  assert.equal(supporterKeyFor(undefined, 'ada', true), null);
});

test('more than 500 handles keeps the newest 500', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 502; i += 1) supporterKeyFor(storage, `person${i}`, true);
  const { keys } = JSON.parse(storage.items.get(SUPPORTER_KEYS));
  assert.equal(Object.keys(keys).length, 500);
  assert.equal(supporterKeyFor(storage, 'person0', false), null);
  assert.equal(supporterKeyFor(storage, 'person1', false), null);
  assert.match(supporterKeyFor(storage, 'person2', false), KEY);
  assert.match(supporterKeyFor(storage, 'person501', false), KEY);
});

test('returningVisitor ignores tipme.supporters.v1: analytics never reads the supporter keys', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../src/lib/analytics.ts', import.meta.url),
    'utf8',
  );
  const returning = /export function returningVisitor\(\)[^{]*\{([^}]*)\}/.exec(
    source,
  );
  assert.ok(returning, 'returningVisitor is where analytics expects it');
  assert.match(returning[1], /getItem\(MY_TIPS_KEY\)/);
  // Only the tip form and the receipt may touch the keys; no analytics or Sentry file does.
  const lib = new URL('../src/lib/', import.meta.url);
  for (const file of await readdir(lib)) {
    if (!/^(analytics|sentry)/.test(file)) continue;
    const text = await readFile(new URL(file, lib), 'utf8');
    assert.ok(!text.includes('supporter-keys'), `${file} imports the keys`);
    assert.ok(!text.includes(SUPPORTER_KEYS), `${file} names the store`);
    assert.ok(!text.includes('SUPPORTER_KEYS'), `${file} names the store`);
  }
});
