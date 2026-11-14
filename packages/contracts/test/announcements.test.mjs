import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  announcementTextProblems,
  opsAnnouncementDraftSchema,
  opsAnnouncementEditSchema,
  opsAnnouncementSendSchema,
} from '../dist/index.js';

// Staff announcements (owner-approved, 14 Nov 2026).
const draft = (extra = {}) => ({
  subject: 'Lower fees on TipMe',
  preheader: 'TipMe’s fee is going down.',
  text: 'From 1 December, TipMe’s fee on each tip is going down.',
  buttonLabel: null,
  buttonUrl: null,
  audience: 'everyone',
  ...extra,
});

test('a draft takes the words, an audience and an optional button', () => {
  assert.equal(opsAnnouncementDraftSchema.safeParse(draft()).success, true);
  assert.equal(
    opsAnnouncementDraftSchema.safeParse(
      draft({ buttonLabel: 'See the fees', buttonUrl: '/pro' }),
    ).success,
    true,
  );
  for (const audience of ['everyone', 'free', 'pro', 'business_owners'])
    assert.equal(
      opsAnnouncementDraftSchema.safeParse(draft({ audience })).success,
      true,
    );
});

test('a draft refuses what an announcement may not hold', () => {
  for (const change of [
    { subject: '' },
    { text: ' ' },
    { audience: 'staff' },
    { buttonLabel: 'Go', buttonUrl: null },
    { buttonLabel: null, buttonUrl: '/pro' },
    { buttonLabel: 'Go', buttonUrl: 'http://example.com' },
    { buttonLabel: 'Go', buttonUrl: 'javascript:alert(1)' },
    { text: 'Our partner Bachs charges a fee.' },
    { subject: 'TipMe is now licensed' },
    { extra: 1 },
  ])
    assert.equal(
      opsAnnouncementDraftSchema.safeParse(draft(change)).success,
      false,
      JSON.stringify(change),
    );
});

test('an edit carries the revision read; a send carries a reason and the revision', () => {
  assert.equal(opsAnnouncementEditSchema.safeParse(draft()).success, false);
  assert.equal(
    opsAnnouncementEditSchema.safeParse({ ...draft(), revision: 2 }).success,
    true,
  );
  assert.equal(
    opsAnnouncementSendSchema.safeParse({ reason: 'short', revision: 1 })
      .success,
    false,
  );
  assert.equal(
    opsAnnouncementSendSchema.safeParse({
      reason: 'Telling everyone about the new fees',
      revision: 1,
    }).success,
    true,
  );
});

test('text problems name the partner and approval claims', () => {
  assert.deepEqual(announcementTextProblems('Paid via bachs, CBN approved'), [
    'provider_name',
    'regulatory_claim',
  ]);
  assert.deepEqual(announcementTextProblems('Lower fees'), []);
});
