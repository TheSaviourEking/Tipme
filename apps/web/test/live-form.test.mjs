import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeServerIntoForm } from '../src/lib/live-form.ts';

// The Task 13 dirty-form rule: a live re-read never overwrites what the person is typing.
const previousServer = { displayName: 'Ada', role: 'Chef', bio: 'Hi' };

test('undirty fields take the server value', () => {
  const server = { displayName: 'Ada O.', role: 'Baker', bio: 'Hi' };
  assert.deepEqual(
    mergeServerIntoForm({
      server,
      previousServer,
      local: { ...previousServer },
      dirty: new Set(),
    }),
    { next: server, changedElsewhere: false },
  );
});

test('a dirty field keeps the person’s input and sets changedElsewhere when its server value changed', () => {
  const server = { displayName: 'Ada O.', role: 'Baker', bio: 'Hi' };
  const local = { displayName: 'Ada typing', role: 'Chef', bio: 'Hi' };
  assert.deepEqual(
    mergeServerIntoForm({
      server,
      previousServer,
      local,
      dirty: new Set(['displayName']),
    }),
    {
      next: { displayName: 'Ada typing', role: 'Baker', bio: 'Hi' },
      changedElsewhere: true,
    },
  );
});

test('no change on the server gives changedElsewhere false', () => {
  const local = { displayName: 'Ada typing', role: 'Chef', bio: 'Hi' };
  assert.deepEqual(
    mergeServerIntoForm({
      server: { ...previousServer },
      previousServer,
      local,
      dirty: new Set(['displayName']),
    }),
    { next: local, changedElsewhere: false },
  );
});

test('a dirty field whose value changed elsewhere to a different field leaves changedElsewhere false', () => {
  const server = { displayName: 'Ada', role: 'Baker', bio: 'Hi' };
  const local = { displayName: 'Ada typing', role: 'Chef', bio: 'Hi' };
  assert.deepEqual(
    mergeServerIntoForm({
      server,
      previousServer,
      local,
      dirty: new Set(['displayName']),
    }),
    {
      next: { displayName: 'Ada typing', role: 'Baker', bio: 'Hi' },
      changedElsewhere: false,
    },
  );
});

test('arrays and objects compare by value', () => {
  const prev = { presets: ['1', '2'] };
  assert.equal(
    mergeServerIntoForm({
      server: { presets: ['1', '2'] },
      previousServer: prev,
      local: { presets: ['9'] },
      dirty: new Set(['presets']),
    }).changedElsewhere,
    false,
  );
  assert.equal(
    mergeServerIntoForm({
      server: { presets: ['1', '3'] },
      previousServer: prev,
      local: { presets: ['9'] },
      dirty: new Set(['presets']),
    }).changedElsewhere,
    true,
  );
});

test('a save of one’s own edit is not news: the server now holds what was typed', () => {
  const local = { displayName: 'Ada typing', role: 'Chef', bio: 'Hi' };
  assert.deepEqual(
    mergeServerIntoForm({
      server: { ...local },
      previousServer,
      local,
      dirty: new Set(['displayName']),
    }),
    { next: local, changedElsewhere: false },
  );
});
