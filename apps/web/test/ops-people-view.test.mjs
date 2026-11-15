import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeWords,
  filtersOn,
  joinedWords,
  pageAfterPerPage,
  pageNumbers,
  peopleSearch,
  readPeopleQuery,
  showingWords,
  withChange,
} from '../src/lib/ops-people-view.ts';

const read = (text) => readPeopleQuery(new URLSearchParams(text));

test('an empty address is page 1 of 25, newest first, nothing filtered', () => {
  assert.deepEqual(read(''), {
    page: 1,
    perPage: 25,
    q: '',
    plan: null,
    pageStatus: null,
    payouts: null,
    joinedFrom: '',
    joinedTo: '',
    sort: 'newest',
  });
  assert.equal(peopleSearch(read('')), '');
});

test('the address round-trips, leaving defaults out so links stay short', () => {
  const text =
    'page=3&perPage=50&q=ada&plan=pro&pageStatus=offline&payouts=set_up&joinedFrom=2026-01-01&joinedTo=2026-02-01&sort=name';
  assert.equal(peopleSearch(read(text)), text);
  assert.equal(peopleSearch(read('page=1&perPage=25&sort=newest')), '');
});

test('nonsense in a shared link falls back to the default, never an error', () => {
  const state = read(
    'page=-4&perPage=30&plan=gold&pageStatus=deleted&payouts=x&joinedFrom=soon&sort=random',
  );
  assert.equal(state.page, 1);
  assert.equal(state.perPage, 25);
  assert.equal(state.plan, null);
  assert.equal(state.pageStatus, null);
  assert.equal(state.payouts, null);
  assert.equal(state.joinedFrom, '');
  assert.equal(state.sort, 'newest');
  assert.equal(read('page=2.5').page, 1);
});

test('the money sort is dropped for someone who cannot see money', () => {
  assert.equal(read('sort=most_tips').sort, 'most_tips');
  assert.equal(
    readPeopleQuery(new URLSearchParams('sort=most_tips'), {
      privateView: false,
    }).sort,
    'newest',
  );
});

test('changing a filter or the search goes back to page 1; turning a page keeps them', () => {
  const state = read('page=4&plan=pro');
  assert.equal(withChange(state, { plan: 'free' }).page, 1);
  assert.equal(withChange(state, { q: 'tunde' }).page, 1);
  assert.equal(withChange(state, { page: 5 }).page, 5);
  assert.equal(withChange(state, { page: 5 }).plan, 'pro');
});

test('page numbers: first, last, the current one and two either side, with gaps', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(2, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageNumbers(2, 42), [1, 2, 3, 4, 'gap', 42]);
  assert.deepEqual(pageNumbers(20, 42), [
    1,
    'gap',
    18,
    19,
    20,
    21,
    22,
    'gap',
    42,
  ]);
  assert.deepEqual(pageNumbers(42, 42), [1, 'gap', 40, 41, 42]);
  // A one-page gap is shown as that page, never as "…".
  assert.deepEqual(pageNumbers(5, 9), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('"Showing 26–50 of 1,284", and the last short page', () => {
  assert.equal(showingWords(2, 25, 1284), 'Showing 26–50 of 1,284');
  assert.equal(showingWords(52, 25, 1284), 'Showing 1,276–1,284 of 1,284');
  assert.equal(showingWords(1, 25, 0), 'Showing 0 of 0');
  assert.equal(showingWords(1, 25, 1), 'Showing 1–1 of 1');
});

test('a new page size keeps the first account on screen in view', () => {
  assert.equal(pageAfterPerPage(2, 25, 50), 1);
  assert.equal(pageAfterPerPage(3, 25, 50), 2);
  assert.equal(pageAfterPerPage(2, 100, 25), 5);
  assert.equal(pageAfterPerPage(1, 50, 100), 1);
});

test('filters on are counted for the phone button; search and sort are not filters', () => {
  assert.equal(filtersOn(read('q=ada&sort=name')), 0);
  assert.equal(
    filtersOn(read('plan=pro&pageStatus=live&joinedFrom=2026-01-01')),
    3,
  );
});

test('joined is a short Lagos date; last active reads like the board', () => {
  assert.equal(joinedWords('2026-11-08T23:30:00Z'), '9 Nov 2026');
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.equal(activeWords('2026-11-14T11:40:00Z', now), 'Within the hour');
  assert.equal(activeWords('2026-11-14T10:00:00Z', now), '2 hours ago');
  assert.equal(activeWords('2026-11-13T09:00:00Z', now), 'Yesterday');
  assert.equal(activeWords('2026-11-10T09:00:00Z', now), '4 days ago');
  assert.equal(activeWords('2026-10-01T09:00:00Z', now), '1 Oct 2026');
  assert.equal(activeWords(null, now), 'Never signed in');
});
