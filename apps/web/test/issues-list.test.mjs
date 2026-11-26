import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INITIAL_ISSUES_LIST,
  issuesListReducer,
} from '../src/lib/issues-list.ts';

// The issues screen's list (apps/web/src/app/ops/issues/page.tsx): a first-page read and a
// "Show more" can be in flight at once, and neither may lose the other's rows.

const rows = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    status: 'open',
    priority: false,
  }));
const PAGE1 = rows('a', 50);
const PAGE2 = rows('b', 7);
const FRESH1 = [
  { id: 'new', status: 'open', priority: false },
  ...rows('a', 49),
];

const shown = () =>
  issuesListReducer(INITIAL_ISSUES_LIST, {
    type: 'first',
    rows: PAGE1,
    mode: 'replace',
  });

test('show more appends to the list it was asked from', () => {
  const one = shown();
  const two = issuesListReducer(one, {
    type: 'more',
    rows: PAGE2,
    generation: one.generation,
  });
  assert.deepEqual(two.issues, [...PAGE1, ...PAGE2]);
  assert.equal(two.extraPages, true);
  assert.equal(two.more, false);
});

test('a signal’s first page that lands after show more offers the change, keeping page 2', () => {
  const one = shown();
  // The signal's read starts with one page showing; the person clicks Show more; that lands first.
  const two = issuesListReducer(one, {
    type: 'more',
    rows: PAGE2,
    generation: one.generation,
  });
  const after = issuesListReducer(two, {
    type: 'first',
    rows: FRESH1,
    mode: 'signal',
  });
  assert.deepEqual(after.issues, [...PAGE1, ...PAGE2]);
  assert.equal(after.extraPages, true);
  assert.equal(after.newChanges, true);
});

test('show more that lands after a newer first page is dropped, never mixing old and new rows', () => {
  const one = shown();
  const askedFrom = one.generation;
  const fresh = issuesListReducer(one, {
    type: 'first',
    rows: FRESH1,
    mode: 'signal',
  });
  assert.deepEqual(fresh.issues, FRESH1);
  const after = issuesListReducer(fresh, {
    type: 'more',
    rows: PAGE2,
    generation: askedFrom,
  });
  assert.equal(after, fresh);
  assert.equal(after.extraPages, false);
});

test('with more pages showing, a resync offers the change only if the first page differs', () => {
  const one = shown();
  const two = issuesListReducer(one, {
    type: 'more',
    rows: PAGE2,
    generation: one.generation,
  });
  const same = issuesListReducer(two, {
    type: 'first',
    rows: PAGE1,
    mode: 'check',
  });
  assert.equal(same.newChanges, false);
  assert.deepEqual(same.issues, [...PAGE1, ...PAGE2]);
  const differs = issuesListReducer(two, {
    type: 'first',
    rows: FRESH1,
    mode: 'check',
  });
  assert.equal(differs.newChanges, true);
  assert.deepEqual(differs.issues, [...PAGE1, ...PAGE2]);
});

test('showing the changes replaces the pages with the fresh first page', () => {
  const one = shown();
  const two = issuesListReducer(one, {
    type: 'more',
    rows: PAGE2,
    generation: one.generation,
  });
  const offered = issuesListReducer(two, {
    type: 'first',
    rows: FRESH1,
    mode: 'signal',
  });
  const after = issuesListReducer(offered, {
    type: 'first',
    rows: FRESH1,
    mode: 'replace',
  });
  assert.deepEqual(after.issues, FRESH1);
  assert.equal(after.extraPages, false);
  assert.equal(after.newChanges, false);
  assert.equal(after.more, true);
  assert.ok(after.generation > offered.generation);
});

test('a failed first page keeps the rows and says so; the next success clears it', () => {
  const one = shown();
  const failed = issuesListReducer(one, { type: 'firstFailed' });
  assert.equal(failed.failed, true);
  assert.deepEqual(failed.issues, PAGE1);
  assert.equal(
    issuesListReducer(failed, { type: 'first', rows: PAGE1, mode: 'signal' })
      .failed,
    false,
  );
});
