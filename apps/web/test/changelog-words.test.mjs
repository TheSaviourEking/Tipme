import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHANGELOG_VIEW_CHOICES,
  changelogNotes,
  changelogStamp,
  changelogView,
  codePointCount,
  firstLine,
  problemWords,
} from '../src/lib/changelog-words.ts';

const row = (over = {}) => ({
  number: 7,
  title: 'feat: x',
  staffText: 'feat: x — Why.',
  state: 'draft',
  unapprovedEdit: false,
  audience: 'everyone',
  publishedAudience: null,
  mergedAt: '2026-11-05T10:00:00.000Z',
  stagingAt: null,
  liveAt: null,
  waitingRequestId: null,
  ...over,
});

test('the four filters, in the board’s order, with All the default', () => {
  assert.deepEqual(
    CHANGELOG_VIEW_CHOICES.map((choice) => [choice.view, choice.label]),
    [
      ['all', 'All'],
      ['drafts', 'Drafts'],
      ['users', 'For users'],
      ['staff', 'Staff only'],
    ],
  );
  assert.equal(changelogView(null), 'all');
  assert.equal(changelogView('drafts'), 'drafts');
  assert.equal(changelogView('nonsense'), 'all');
});

test('the state stamp says where an entry is', () => {
  assert.equal(changelogStamp(row()), 'Draft');
  assert.equal(changelogStamp(row({ state: 'recorded' })), 'Recorded');
  assert.equal(changelogStamp(row({ state: 'withdrawn' })), 'Withdrawn');
  assert.equal(
    changelogStamp(row({ state: 'approved' })),
    'Approved · not on staging yet',
  );
  assert.equal(
    changelogStamp(
      row({ state: 'approved', stagingAt: '2026-11-05T12:00:00.000Z' }),
    ),
    'Approved · on staging',
  );
  // Lagos time: 23:30 UTC on 5 Nov is already 6 Nov there.
  assert.equal(
    changelogStamp(row({ state: 'live', liveAt: '2026-11-05T23:30:00.000Z' })),
    'Live 6 Nov',
  );
});

test('the notes: an unapproved edit, a waiting request, and an edit since asking', () => {
  assert.deepEqual(changelogNotes(row()), []);
  assert.deepEqual(
    changelogNotes(row({ state: 'live', unapprovedEdit: true })),
    ['Edited, waiting for approval'],
  );
  assert.deepEqual(changelogNotes(row({ waitingRequestId: 'r1' })), [
    'Waiting in Approvals',
  ]);
  assert.deepEqual(
    changelogNotes(row({ waitingRequestId: 'r1', editedSinceAsking: true })),
    ['Waiting in Approvals', 'Edited since asking'],
  );
  // An older API leaves editedSinceAsking out: no claim either way.
  assert.deepEqual(
    changelogNotes(
      row({ waitingRequestId: 'r1', editedSinceAsking: undefined }),
    ),
    ['Waiting in Approvals'],
  );
});

test('problems in words, never naming the provider', () => {
  const words = problemWords(['provider_name', 'regulatory_claim', 'too_long']);
  assert.equal(words.length, 3);
  assert.match(words[0], /our payment partner/);
  assert.match(words[1], /licensed|approved/);
  assert.match(words[2], /280/);
  for (const line of words) assert.doesNotMatch(line, /bachs/i);
  // From the 422's reason: a comma list, unknown names ignored.
  assert.deepEqual(
    problemWords('provider_name,whatever'.split(',')),
    problemWords(['provider_name']),
  );
});

test('counts code points, as the server does, and takes the first line', () => {
  assert.equal(codePointCount('😀'.repeat(3)), 3);
  assert.equal(codePointCount(''), 0);
  assert.equal(firstLine('One.\nTwo.'), 'One.');
  assert.equal(firstLine('  Lone  '), 'Lone');
});
