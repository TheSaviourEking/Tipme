import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freezeView } from '../src/lib/withdrawal-freeze-view.ts';

test('a frozen page says so, and offers another report', () => {
  const view = freezeView({
    ok: true,
    data: { issueId: 'i1', issueOpen: true },
  });
  assert.equal(view.state, 'frozen');
  assert.equal(view.issueId, 'i1');
  assert.equal(view.issueOpen, true);
  assert.equal(view.open, 'Record another report…');
});

test('frozen by a closed report: still frozen, and a report is what opens a new issue', () => {
  const view = freezeView({
    ok: true,
    data: { issueId: 'i1', issueOpen: false },
  });
  assert.equal(view.state, 'frozen');
  assert.equal(view.issueOpen, false);
  assert.equal(view.open, 'Record a new report…');
});

test('only a successful read showing none is "not frozen"', () => {
  assert.equal(
    freezeView({ ok: true, data: { issueId: null, issueOpen: false } }).state,
    'clear',
  );
});

test('a failed read or one still going never reads as not frozen, and stopping stays possible', () => {
  for (const read of [{ ok: false }, null]) {
    const view = freezeView(read);
    assert.equal(view.state, 'unknown');
    assert.notEqual(view.open, 'Freeze withdrawals…');
    assert.ok(view.open, 'the way to stop stays');
  }
  assert.match(freezeView({ ok: false }).warning, /couldn’t check/i);
});
