import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUSINESS_NOTE_LIMIT,
  BUSINESS_NOTE_TAGS,
  BUSINESS_NOTIFICATION_KINDS,
  INVITATION_TARGETS,
  ISSUE_KINDS,
  MIN_GROUP,
  OPS_CATALOGUE,
  OPS_PERMISSIONS,
  apiErrorCodes,
  businessApplicationSchema,
  businessNoteRequestSchema,
  businessSlugSchema,
  businessUpdateSchema,
  hasContactDetails,
  insightsQuerySchema,
  invitationBlockSchema,
  invitationCodeSchema,
  invitationRequestSchema,
  inviteeQuerySchema,
  locationInputSchema,
  locationUpdateSchema,
  memberDisplaySchema,
  noteReportSchema,
  shareAmountsSchema,
  shownCount,
  tipIntentRequestSchema,
} from '../dist/index.js';

const LOCATION = '0195a1b2-0000-7000-8000-000000000001';
const ok = (schema, value) => schema.safeParse(value).success;

test('shownCount: 0 shows as 0 (nothing to protect); 1 and 2 are { fewerThan: 3 }; 3 and up show', () => {
  assert.equal(MIN_GROUP, 3);
  assert.deepEqual(shownCount(0), { n: 0 });
  assert.deepEqual(shownCount(1), { fewerThan: 3 });
  assert.deepEqual(shownCount(2), { fewerThan: 3 });
  assert.deepEqual(shownCount(3), { n: 3 });
  assert.deepEqual(shownCount(40), { n: 40 });
});

test('the tags are the owner’s default list (O3)', () => {
  assert.deepEqual(
    BUSINESS_NOTE_TAGS.map((tag) => tag.label),
    ['Friendly', 'Fast', 'Went the extra mile', 'Great advice', 'Made my day'],
  );
});

test('businessNoteRequestSchema: tags unique, at most 5, known ids; body optional; one of them needed', () => {
  assert.ok(ok(businessNoteRequestSchema, { tags: ['friendly'] }));
  assert.ok(ok(businessNoteRequestSchema, { tags: [], body: 'Lovely' }));
  assert.ok(ok(businessNoteRequestSchema, { body: 'Lovely' }));
  assert.ok(
    ok(businessNoteRequestSchema, {
      tags: BUSINESS_NOTE_TAGS.map((tag) => tag.id),
    }),
  );
  assert.ok(!ok(businessNoteRequestSchema, { tags: [] }));
  assert.ok(!ok(businessNoteRequestSchema, { tags: [], body: '   ' }));
  assert.ok(!ok(businessNoteRequestSchema, { tags: ['rude'] }));
  assert.ok(!ok(businessNoteRequestSchema, { tags: ['fast', 'fast'] }));
  assert.ok(
    !ok(businessNoteRequestSchema, {
      tags: [
        'fast',
        'friendly',
        'extra_mile',
        'great_advice',
        'made_my_day',
        'fast',
      ],
    }),
  );
  assert.ok(!ok(businessNoteRequestSchema, { tags: ['fast'], stars: 5 }));
  // The body is cleaned before it is stored.
  assert.equal(
    businessNoteRequestSchema.parse({ body: '  Kind​  and   quick ' }).body,
    'Kind and quick',
  );
});

test('a note body with a link, an email or a phone number is refused', () => {
  for (const body of [
    'see tobi.ng',
    'mail me a@b.co',
    'call 0803 123 4567',
    '+234 803 123 4567',
    '0803-123-4567',
    'tobi­.ng',
    'www.example',
    'https://x.y',
  ]) {
    const result = businessNoteRequestSchema.safeParse({ body });
    assert.equal(result.success, false, body);
    assert.deepEqual(result.error.issues[0].path, ['body'], body);
  }
  for (const body of [
    'Table 12 was lovely',
    'Best of 2026!',
    'He fixed it in 5 minutes',
    'Came at 8, left at 10',
  ])
    assert.ok(ok(businessNoteRequestSchema, { body }), body);
  assert.equal(hasContactDetails('reach me on 08031234567'), true);
  assert.equal(hasContactDetails('ada@example.com'), true);
  assert.equal(hasContactDetails('Table 12, 2026'), false);
});

test('the body counts code points: 280 emoji pass, 281 fail', () => {
  assert.equal(BUSINESS_NOTE_LIMIT, 280);
  assert.ok(ok(businessNoteRequestSchema, { body: '😀'.repeat(280) }));
  assert.ok(!ok(businessNoteRequestSchema, { body: '😀'.repeat(281) }));
  assert.ok(!ok(businessNoteRequestSchema, { body: 'a'.repeat(281) }));
});

test('invitations have three targets: email, link and a TipMe username (owner, 6 Nov)', () => {
  assert.deepEqual([...INVITATION_TARGETS], ['email', 'link', 'user']);
  const staff = (target) => ({ kind: 'staff', locationId: LOCATION, target });
  assert.ok(ok(invitationRequestSchema, staff({ kind: 'link' })));
  assert.equal(
    invitationRequestSchema.parse(
      staff({ kind: 'email', email: ' Tobi@Example.COM ' }),
    ).target.email,
    'tobi@example.com',
  );
  assert.equal(
    invitationRequestSchema.parse(staff({ kind: 'user', handle: '@Tobi' }))
      .target.handle,
    'tobi',
  );
  assert.ok(
    !ok(invitationRequestSchema, staff({ kind: 'email', email: 'nope' })),
  );
  assert.ok(
    !ok(invitationRequestSchema, staff({ kind: 'user', handle: 'a b' })),
  );
  assert.ok(
    !ok(invitationRequestSchema, staff({ kind: 'sms', phone: '0803' })),
  );
  assert.ok(
    !ok(invitationRequestSchema, staff({ kind: 'link', email: 'a@b.co' })),
  );
});

test('invitationRequestSchema: staff needs a locationId; manager owner has none; location_manager needs one', () => {
  const target = { kind: 'link' };
  assert.ok(!ok(invitationRequestSchema, { kind: 'staff', target }));
  assert.ok(
    ok(invitationRequestSchema, { kind: 'manager', role: 'owner', target }),
  );
  assert.ok(
    !ok(invitationRequestSchema, {
      kind: 'manager',
      role: 'owner',
      locationId: LOCATION,
      target,
    }),
  );
  assert.ok(
    ok(invitationRequestSchema, {
      kind: 'manager',
      role: 'location_manager',
      locationId: LOCATION,
      target,
    }),
  );
  assert.ok(
    !ok(invitationRequestSchema, {
      kind: 'manager',
      role: 'location_manager',
      target,
    }),
  );
  assert.ok(
    !ok(invitationRequestSchema, { kind: 'staff', locationId: LOCATION }),
  );
});

test('invitation codes are 16 base32 characters', () => {
  assert.ok(ok(invitationCodeSchema, { code: 'ABCDEFGHIJKLMNOP' }));
  assert.ok(ok(invitationCodeSchema, { code: 'ABCDEFGH23456723' }));
  for (const code of [
    'ABCDEFGHIJKLMNO',
    'ABCDEFGHIJKLMNOPQ',
    'abcdefghijklmnop',
    'ABCDEFGHIJKLMN01',
  ])
    assert.ok(!ok(invitationCodeSchema, { code }), code);
});

test('the invited person blocks invitations per business; username search takes a short query', () => {
  assert.ok(ok(invitationBlockSchema, { blocked: true }));
  assert.ok(!ok(invitationBlockSchema, { blocked: 'yes' }));
  assert.ok(ok(inviteeQuerySchema, { q: 'to' }));
  assert.ok(!ok(inviteeQuerySchema, { q: 't' }));
  assert.ok(!ok(inviteeQuerySchema, { q: 'x'.repeat(31) }));
});

test('business, location and member inputs', () => {
  assert.equal(businessSlugSchema.parse(' Yellow-Chilli '), 'yellow-chilli');
  assert.ok(!businessSlugSchema.safeParse('-x').success);
  assert.ok(!businessSlugSchema.safeParse('a'.repeat(41)).success);
  const application = {
    name: 'The Yellow Chilli',
    slug: 'yellow-chilli',
    contactName: 'Funke',
    contactEmail: 'funke@example.com',
    location: {
      name: 'Victoria Island',
      slug: 'vi',
      address: '27 Ademola Adetokunbo',
    },
  };
  assert.ok(ok(businessApplicationSchema, application));
  assert.ok(
    ok(businessApplicationSchema, {
      ...application,
      contactPhone: '+234 803 000 0000',
    }),
  );
  assert.ok(!ok(businessApplicationSchema, { ...application, extra: 1 }));
  assert.ok(
    !ok(businessApplicationSchema, {
      ...application,
      location: { ...application.location, slug: 'a'.repeat(31) },
    }),
  );
  assert.ok(ok(businessUpdateSchema, { contactPhone: null }));
  assert.ok(!ok(businessUpdateSchema, { status: 'verified' }));
  assert.ok(!ok(locationInputSchema, { name: '', slug: 'vi', address: 'x' }));
  assert.ok(ok(memberDisplaySchema, { shownName: 'Tobi', showPhoto: false }));
  assert.ok(!ok(memberDisplaySchema, { shownName: 'x'.repeat(31) }));
  assert.ok(ok(shareAmountsSchema, { share: true }));
  assert.ok(ok(noteReportSchema, { reason: 'spam' }));
  assert.ok(!ok(noteReportSchema, { reason: 'boring' }));
  assert.ok(
    ok(insightsQuerySchema, { locationId: LOCATION, week: '2026-W45' }),
  );
  assert.ok(
    !ok(insightsQuerySchema, { locationId: LOCATION, week: '2026-45' }),
  );
});

test('tipIntentRequestSchema accepts businessMemberId as a uuid and nothing else', () => {
  const base = { quoteId: LOCATION };
  assert.ok(ok(tipIntentRequestSchema, base));
  assert.ok(
    ok(tipIntentRequestSchema, { ...base, businessMemberId: LOCATION }),
  );
  for (const businessMemberId of ['tobi', 42, '', null])
    assert.ok(
      !ok(tipIntentRequestSchema, { ...base, businessMemberId }),
      String(businessMemberId),
    );
  assert.ok(
    !ok(tipIntentRequestSchema, { ...base, businessLocationId: LOCATION }),
  );
});

test('the catalogue has businesses.manage, sensitive, in people', () => {
  assert.ok(OPS_PERMISSIONS.includes('businesses.manage'));
  assert.deepEqual(OPS_CATALOGUE['businesses.manage'], {
    description: 'Verify, suspend and restore businesses, with a reason',
    group: 'people',
    sensitive: true,
  });
});

test('ISSUE_KINDS has business_waiting and business_note_reported', () => {
  assert.ok(ISSUE_KINDS.includes('business_waiting'));
  assert.ok(ISSUE_KINDS.includes('business_note_reported'));
});

test('the business notification kinds and error codes exist', () => {
  assert.deepEqual(
    [...BUSINESS_NOTIFICATION_KINDS],
    ['business_invitation', 'business_verified'],
  );
  for (const code of [
    'BUSINESS_NOT_FOUND',
    'BUSINESS_SLUG_TAKEN',
    'LOCATION_SLUG_TAKEN',
    'SLUG_LOCKED',
    'OWNER_REQUIRED',
    'INVITATION_INVALID',
    'ALREADY_A_MEMBER',
    'MEMBER_NOT_TIPPABLE',
    'NOTE_NOT_OPEN',
    'BUSINESS_LAST_OWNER',
    'BUSINESS_NOT_VERIFIED',
    'INVITATIONS_BLOCKED',
    'INVITEE_UNAVAILABLE',
  ])
    assert.ok(apiErrorCodes.includes(code), code);
  // Answered as "not found", so another business's id reads exactly like an unknown one.
  assert.ok(!apiErrorCodes.includes('NOT_A_MANAGER'));
});

test('a location can never be slugged "people": that path is the public search (B4)', () => {
  for (const slug of ['people', 'PEOPLE', ' people '])
    assert.ok(
      !locationInputSchema.safeParse({ name: 'P', slug, address: 'x' }).success,
      slug,
    );
  assert.ok(
    !locationUpdateSchema.safeParse({ slug: 'people' }).success,
    'nor renamed to it',
  );
  assert.ok(
    locationInputSchema.safeParse({ name: 'P', slug: 'people-2', address: 'x' })
      .success,
  );
  // A business may still be called "people": only the location segment is taken.
  assert.ok(businessSlugSchema.safeParse('people').success);
});

test('a verified business can not be renamed: BUSINESS_NAME_LOCKED is a code of its own', () => {
  assert.ok(apiErrorCodes.includes('BUSINESS_NAME_LOCKED'));
});
