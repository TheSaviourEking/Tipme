import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHANGELOG_AUDIENCES,
  CHANGELOG_STAFF_TEXT_LIMIT,
  CHANGELOG_USER_TEXT_LIMIT,
  PROVIDER_WORD,
  changelogDraftSchema,
  changelogPendingSchema,
  changelogReleaseSchema,
  changelogState,
  draftFromPullRequest,
  firstParagraph,
  forUsersSection,
  hasUnapprovedEdit,
  opsChangelogEditSchema,
  opsChangelogQuerySchema,
  shownToUser,
  userLine,
  userTextProblems,
  whatsNewSeenSchema,
} from '../dist/index.js';

const points = (s) => Array.from(s).length;

test('firstParagraph stops at the first blank line or heading and drops HTML comments', () => {
  assert.equal(
    firstParagraph('Fixes the bell.\nIt was slow.\n\n## Scope'),
    'Fixes the bell. It was slow.',
  );
  assert.equal(
    firstParagraph('Fixes the bell.\n## Scope\nmore'),
    'Fixes the bell.',
  );
  assert.equal(firstParagraph('<!-- hint -->\nText'), 'Text');
  assert.equal(
    firstParagraph('<!-- a\nlong\nhint -->\n\nText\nmore\n\nlater'),
    'Text more',
  );
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph(null), '');
  assert.equal(firstParagraph(undefined), '');
  // The repo's template opens with headings: the paragraph is the first text under them.
  assert.equal(
    firstParagraph('## Scope and PRD IDs\nAdds a bell.\n\n## Evidence'),
    'Adds a bell.',
  );
});

test('forUsersSection reads "## For users" up to the next heading, any level and case', () => {
  assert.equal(
    forUsersSection(
      '## Scope\nx\n## For users\n<!-- what users notice -->\nYou can now…\n\n## Evidence',
    ),
    'You can now…',
  );
  assert.equal(
    forUsersSection('# FOR USERS\nYou can pin\n  a note.\n### Next\nno'),
    'You can pin a note.',
  );
  assert.equal(forUsersSection('###for users   \nShort.'), 'Short.');
  assert.equal(forUsersSection('## Scope\nx'), '');
  assert.equal(
    forUsersSection(
      '## For users\n<!-- One or two sentences -->\n\n## Evidence',
    ),
    '',
  );
  assert.equal(forUsersSection('## For users and staff\nno'), '');
  assert.equal(forUsersSection(''), '');
});

test('draftFromPullRequest: empty For users makes a staff-only entry', () => {
  assert.deepEqual(
    draftFromPullRequest({
      title: 'fix(ci): x',
      body: 'Why.\n\n## For users\n',
    }),
    { staffText: 'fix(ci): x — Why.', userText: null, audience: 'staff' },
  );
  assert.deepEqual(draftFromPullRequest({ title: 'fix(ci): x', body: null }), {
    staffText: 'fix(ci): x',
    userText: null,
    audience: 'staff',
  });
});

test('draftFromPullRequest: a For users section becomes the working user text, audience everyone', () => {
  assert.deepEqual(
    draftFromPullRequest({
      title: 'feat(web): pinned notes',
      body: 'Adds pins.\n\n## For users\n<!-- hint -->\nYou can pin a supporter note.\n\n## Evidence\nok',
    }),
    {
      staffText: 'feat(web): pinned notes — Adds pins.',
      userText: 'You can pin a supporter note.',
      audience: 'everyone',
    },
  );
});

test('staff text and user text are cut at a word within their limits, counted in code points', () => {
  const emoji = draftFromPullRequest({
    title: 't',
    body: `## For users\n${'😀'.repeat(300)}`,
  });
  assert.equal(points(emoji.userText), CHANGELOG_USER_TEXT_LIMIT);
  assert.equal(CHANGELOG_USER_TEXT_LIMIT, 280);

  const words = draftFromPullRequest({
    title: 't',
    body: `## For users\n${'word '.repeat(100)}`,
  });
  assert.ok(points(words.userText) <= 280);
  // Cut between words, never inside one.
  assert.match(words.userText, /^(word )*word…$/);

  const staff = draftFromPullRequest({
    title: 'title',
    body: 'long '.repeat(400),
  });
  assert.equal(CHANGELOG_STAFF_TEXT_LIMIT, 1000);
  assert.ok(points(staff.staffText) <= 1000);
  assert.match(staff.staffText, /^title — (long )*long…$/);
});

test('userTextProblems flags the provider name and regulatory claims, and passes plain updates', () => {
  assert.deepEqual(userTextProblems('Payouts via Bachs are faster'), [
    'provider_name',
  ]);
  assert.deepEqual(userTextProblems('TipMe is now licensed'), [
    'regulatory_claim',
  ]);
  assert.deepEqual(userTextProblems('You can pin a supporter note.'), []);
  assert.deepEqual(userTextProblems('Approved by the CBN'), [
    'regulatory_claim',
  ]);
  assert.deepEqual(userTextProblems('Your tips are insured'), [
    'regulatory_claim',
  ]);
  assert.deepEqual(userTextProblems('x'.repeat(281)), ['too_long']);
  assert.deepEqual(userTextProblems('😀'.repeat(280)), []);
  assert.deepEqual(userTextProblems('BACHS is regulated'), [
    'provider_name',
    'regulatory_claim',
  ]);
  // The word only, as the web's provider-name test reads it.
  assert.deepEqual(userTextProblems('Bachsmith made the cover'), []);
  assert.equal(PROVIDER_WORD.test('bachs'), true);
});

test('changelogState covers draft, approved, live, recorded and withdrawn', () => {
  const base = {
    audience: 'everyone',
    publishedRevision: null,
    liveAt: null,
    withdrawnAt: null,
  };
  assert.equal(changelogState(base), 'draft');
  assert.equal(changelogState({ ...base, audience: 'staff' }), 'recorded');
  assert.equal(
    changelogState({
      ...base,
      audience: 'staff',
      liveAt: '2026-11-06T10:00:00Z',
    }),
    'recorded',
  );
  assert.equal(changelogState({ ...base, publishedRevision: 1 }), 'approved');
  assert.equal(
    changelogState({
      ...base,
      publishedRevision: 1,
      liveAt: '2026-11-06T10:00:00Z',
    }),
    'live',
  );
  assert.equal(
    changelogState({
      ...base,
      publishedRevision: 1,
      withdrawnAt: '2026-11-06T10:00:00Z',
    }),
    'withdrawn',
  );
  // Approved as staff only: recorded. A user text removed but not yet approved: still live.
  assert.equal(
    changelogState({
      ...base,
      audience: 'staff',
      publishedAudience: 'staff',
      publishedRevision: 2,
    }),
    'recorded',
  );
  assert.equal(
    changelogState({
      ...base,
      audience: 'staff',
      publishedAudience: 'everyone',
      publishedRevision: 1,
      liveAt: '2026-11-06T10:00:00Z',
    }),
    'live',
  );
  assert.equal(
    changelogState({
      ...base,
      audience: 'staff',
      withdrawnAt: '2026-11-06T10:00:00Z',
    }),
    'withdrawn',
  );
});

test('hasUnapprovedEdit is true only after an edit to an approved entry', () => {
  assert.equal(
    hasUnapprovedEdit({ revision: 1, publishedRevision: null }),
    false,
  );
  assert.equal(hasUnapprovedEdit({ revision: 3, publishedRevision: 3 }), false);
  assert.equal(hasUnapprovedEdit({ revision: 4, publishedRevision: 3 }), true);
});

test('shownToUser: everyone and pro to all pages; early_access only to Pro with it on; staff never', () => {
  const free = { plan: 'free', earlyAccess: false };
  const pro = { plan: 'pro', earlyAccess: false };
  const proEarly = { plan: 'pro', earlyAccess: true };
  const freeEarly = { plan: 'free', earlyAccess: true };
  const unknown = { plan: undefined, earlyAccess: false };
  for (const who of [free, pro, proEarly, unknown]) {
    assert.equal(shownToUser({ publishedAudience: 'everyone' }, who), true);
    assert.equal(shownToUser({ publishedAudience: 'pro' }, who), true);
    assert.equal(shownToUser({ publishedAudience: 'staff' }, who), false);
    assert.equal(shownToUser({ publishedAudience: null }, who), false);
  }
  assert.equal(
    shownToUser({ publishedAudience: 'early_access' }, proEarly),
    true,
  );
  for (const who of [free, pro, freeEarly, unknown])
    assert.equal(
      shownToUser({ publishedAudience: 'early_access' }, who),
      false,
    );
});

test('userLine adds "On Pro, " to Pro entries once', () => {
  assert.equal(
    userLine({ text: 'you can pick a starting amount.', audience: 'pro' }),
    'On Pro, you can pick a starting amount.',
  );
  assert.equal(
    userLine({ text: 'You can pick a starting amount.', audience: 'pro' }),
    'On Pro, you can pick a starting amount.',
  );
  assert.equal(
    userLine({ text: 'On Pro you can x.', audience: 'pro' }),
    'On Pro you can x.',
  );
  assert.equal(
    userLine({ text: 'on pro, you can x.', audience: 'pro' }),
    'on pro, you can x.',
  );
  assert.equal(
    userLine({ text: 'You can x.', audience: 'everyone' }),
    'You can x.',
  );
  assert.equal(
    userLine({ text: 'You can x.', audience: 'early_access' }),
    'You can x.',
  );
});

test('wire schemas are strict and bounded', () => {
  const draft = {
    number: 140,
    title: 'feat: x',
    body: 'Why.',
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-11-06T10:00:00Z',
  };
  assert.equal(changelogDraftSchema.safeParse(draft).success, true);
  assert.equal(
    changelogDraftSchema.safeParse({ ...draft, body: null }).success,
    true,
  );
  for (const bad of [
    { ...draft, mergeCommitSha: 'a'.repeat(41) },
    { ...draft, mergeCommitSha: 'A'.repeat(40) },
    { ...draft, body: 'x'.repeat(65537) },
    { ...draft, title: 'x'.repeat(257) },
    { ...draft, title: '' },
    { ...draft, number: 0 },
    { ...draft, number: 1.5 },
    { ...draft, mergedAt: 'yesterday' },
    { ...draft, extra: 1 },
  ])
    assert.equal(
      changelogDraftSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 80),
    );

  assert.equal(
    changelogPendingSchema.safeParse({ environment: 'staging' }).success,
    true,
  );
  assert.equal(
    changelogPendingSchema.safeParse({ environment: 'dev' }).success,
    false,
  );
  assert.equal(
    changelogPendingSchema.safeParse({ environment: 'production', x: 1 })
      .success,
    false,
  );

  const release = {
    environment: 'production',
    version: 'abcdef012345',
    contained: [1, 2],
  };
  assert.equal(changelogReleaseSchema.safeParse(release).success, true);
  for (const bad of [
    { ...release, version: 'abcdef01234' },
    { ...release, version: 'ABCDEF012345' },
    { ...release, contained: Array.from({ length: 2001 }, (_, i) => i + 1) },
    { ...release, contained: [1, 1] },
    { ...release, contained: [0] },
    { ...release, extra: true },
  ])
    assert.equal(changelogReleaseSchema.safeParse(bad).success, false);
  assert.equal(
    changelogReleaseSchema.safeParse({
      ...release,
      contained: Array.from({ length: 2000 }, (_, i) => i + 1),
    }).success,
    true,
  );
});

test('admin and user schemas', () => {
  assert.deepEqual(opsChangelogQuerySchema.parse({}), { view: 'all' });
  assert.deepEqual(
    opsChangelogQuerySchema.parse({ view: 'drafts', before: '50' }),
    {
      view: 'drafts',
      before: 50,
    },
  );
  assert.equal(
    opsChangelogQuerySchema.safeParse({ view: 'live' }).success,
    false,
  );
  assert.equal(opsChangelogEditSchema.safeParse({ revision: 1 }).success, true);
  assert.equal(
    opsChangelogEditSchema.safeParse({
      revision: 1,
      userText: null,
      audience: 'staff',
    }).success,
    true,
  );
  for (const bad of [
    {},
    { revision: 1, staffText: '' },
    { revision: 1, staffText: 'x'.repeat(1001) },
    { revision: 1, userText: '' },
    { revision: 1, userText: 'x'.repeat(281) },
    { revision: 1, audience: 'friends' },
    { revision: 1, extra: 1 },
  ])
    assert.equal(
      opsChangelogEditSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 60),
    );
  assert.equal(
    opsChangelogEditSchema.safeParse({
      revision: 1,
      userText: '😀'.repeat(280),
    }).success,
    true,
  );
  assert.deepEqual(
    [...CHANGELOG_AUDIENCES],
    ['staff', 'everyone', 'pro', 'early_access'],
  );
  assert.equal(
    whatsNewSeenSchema.safeParse({ through: '2026-11-06T10:00:00Z' }).success,
    true,
  );
  assert.equal(whatsNewSeenSchema.safeParse({ through: 'now' }).success, false);
  assert.equal(
    whatsNewSeenSchema.safeParse({ through: '2026-11-06T10:00:00Z', x: 1 })
      .success,
    false,
  );
});
