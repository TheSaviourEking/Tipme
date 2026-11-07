import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  acceptBusinessInvitation,
  declineBusinessInvitation,
  inviteToBusiness,
  listBusinessInvitations,
  mailSealing,
  myBusinessRoles,
  myInvitations,
  openSecret,
  previewBusinessInvitation,
  revokeBusinessInvitation,
  searchInvitees,
  setInvitationBlock,
} from '../../dist/index.js';
import { seedBusiness, seedManager, seedMember } from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B3 Task 11: invitations by email, one-time link or TipMe username. A
// business never makes an account; an answer is one of "valid" or INVITATION_INVALID.

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const codeOf = (link) => link.split('#join=')[1];
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });

/** Another TipMe account with its own page. */
async function person(
  database,
  {
    handle,
    email = null,
    verified = true,
    pageState = 'live',
    status = 'active',
    visibility = 'public',
  },
) {
  const userId = randomUUID();
  const profileId = randomUUID();
  await database.pool.query(
    `INSERT INTO users (id, phone_e164, email, email_verified_at) VALUES ($1, $2, $3, $4)`,
    [
      userId,
      `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      email,
      email && verified ? new Date() : null,
    ],
  );
  await database.pool.query(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, status, visibility)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
    [
      profileId,
      userId,
      handle,
      `${handle[0].toUpperCase()}${handle.slice(1)} Person`,
      pageState,
      status,
      visibility,
    ],
  );
  return { userId, profileId };
}

test('business invitations', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  // Tobi owns The Yellow Chilli (VI and Ikoyi).
  const setUp = async () => {
    await database.fresh();
    return seedBusiness(database, {
      owner: TOBI.userId,
      locations: [
        { slug: 'vi', name: 'Victoria Island' },
        { slug: 'ikoyi', name: 'Ikoyi' },
      ],
    });
  };
  const staffLink = (business, location = business.locations[0].id) =>
    inviteToBusiness(database.db, sealing, TOBI.userId, business.businessId, {
      kind: 'staff',
      locationId: location,
      target: { kind: 'link' },
    });

  await t.test(
    'a link invitation stores only a hash and gives the link once, in the fragment',
    async () => {
      const business = await setUp();
      const created = await staffLink(business);
      assert.match(created.link, /^\/dashboard\/work#join=[A-Z2-7]{16}$/);
      const [row] = await q(
        `SELECT code_sha256, target, expires_at - created_at AS life FROM business_invitations WHERE id = $1`,
        [created.id],
      );
      assert.equal(row.target, 'link');
      assert.notEqual(row.code_sha256, codeOf(created.link));
      assert.equal(row.life.days, 7);
      // Nobody is mailed or notified for a link.
      assert.equal(await database.count('mail_messages'), 0);
      assert.equal(await database.count('notifications'), 0);
    },
  );

  await t.test(
    'a link invitation is accepted once; a second accept, a revoked, expired or unknown code: INVITATION_INVALID',
    async () => {
      const business = await setUp();
      const created = await staffLink(business);
      const code = codeOf(created.link);
      assert.deepEqual(
        await previewBusinessInvitation(database.db, ADA.userId, { code }),
        {
          businessName: 'The Yellow Chilli',
          locationName: 'Victoria Island',
          kind: 'staff',
          verified: true,
        },
      );
      const accepted = await acceptBusinessInvitation(database.db, ADA.userId, {
        code,
      });
      assert.equal(accepted.kind, 'staff');
      assert.equal(accepted.membership.shownName, 'Ada');
      assert.equal(accepted.membership.location.name, 'Victoria Island');
      assert.equal(
        accepted.membership.staffCodePath,
        `/b/${business.slug}/vi/ada`,
      );
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, { code }),
        'INVITATION_INVALID',
      );
      await rejects(
        acceptBusinessInvitation(database.db, TOBI.userId, { code }),
        'INVITATION_INVALID',
      );
      // Revoked.
      const revoked = await staffLink(business, business.locations[1].id);
      await revokeBusinessInvitation(
        database.db,
        TOBI.userId,
        business.businessId,
        revoked.id,
      );
      await rejects(
        previewBusinessInvitation(database.db, ADA.userId, {
          code: codeOf(revoked.link),
        }),
        'INVITATION_INVALID',
      );
      // Expired.
      const expired = await staffLink(business, business.locations[1].id);
      await q(
        `UPDATE business_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired.id],
      );
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, {
          code: codeOf(expired.link),
        }),
        'INVITATION_INVALID',
      );
      // Unknown.
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, {
          code: 'AAAAAAAAAAAAAAAA',
        }),
        'INVITATION_INVALID',
      );
      // A link's id is not its secret: it can't be answered by id.
      const other = await staffLink(business, business.locations[1].id);
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, {
          invitationId: other.id,
        }),
        'INVITATION_INVALID',
      );
    },
  );

  await t.test(
    'two accepts racing on one link make one membership',
    async () => {
      const business = await setUp();
      const created = await staffLink(business);
      const code = codeOf(created.link);
      const outcomes = await Promise.allSettled([
        acceptBusinessInvitation(database.db, ADA.userId, { code }),
        acceptBusinessInvitation(database.db, ADA.userId, { code }),
        acceptBusinessInvitation(database.db, ADA.userId, { code }),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      for (const o of outcomes.filter((o) => o.status === 'rejected'))
        assert.equal(o.reason.code, 'INVITATION_INVALID');
      assert.equal(
        (await q(`SELECT count(*)::int AS n FROM business_members`))[0].n,
        1,
      );
    },
  );

  await t.test(
    'an email invitation is accepted only by an account whose proven email matches',
    async () => {
      const business = await setUp();
      const kemi = await person(database, {
        handle: 'kemi',
        email: 'Kemi@Example.com',
      });
      const unproven = await person(database, {
        handle: 'bola',
        email: 'bola@example.com',
        verified: false,
      });
      const created = await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'staff',
          locationId: business.locations[0].id,
          target: { kind: 'email', email: 'kemi@example.com' },
        },
      );
      assert.equal(
        created.link,
        undefined,
        'an email invitation shows no link',
      );
      // The email carries the code; the notification goes to the account with that proven address.
      const [mail] = await q(
        `SELECT type, data_sealed, user_id, dedupe_key FROM mail_messages`,
      );
      assert.equal(mail.type, 'business_invitation');
      assert.equal(mail.user_id, kemi.userId);
      const data = JSON.parse(openSecret(sealing.key, mail.data_sealed));
      assert.match(data.code, /^[A-Z2-7]{16}$/);
      assert.equal(data.businessName, 'The Yellow Chilli');
      const [note] = await q(
        `SELECT user_id, kind, invitation_id, business_id FROM notifications`,
      );
      assert.deepEqual(note, {
        user_id: kemi.userId,
        kind: 'business_invitation',
        invitation_id: created.id,
        business_id: business.businessId,
      });
      // Someone else, or the same address unproven, gets the one answer.
      for (const userId of [ADA.userId, unproven.userId])
        await rejects(
          acceptBusinessInvitation(database.db, userId, { code: data.code }),
          'INVITATION_INVALID',
        );
      // It shows on Kemi's Work page and is counted for the Work link.
      const mine = await myInvitations(database.db, kemi.userId);
      assert.equal(mine.invitations.length, 1);
      assert.equal(mine.invitations[0].id, created.id);
      assert.equal(
        (await myBusinessRoles(database.db, kemi.userId)).invitations,
        1,
      );
      // Answered by id from the Work page.
      const accepted = await acceptBusinessInvitation(
        database.db,
        kemi.userId,
        {
          invitationId: created.id,
        },
      );
      assert.equal(accepted.kind, 'staff');
      const [read] = await q(`SELECT read_at FROM notifications`);
      assert.ok(read.read_at, 'answering marks the notification read');
    },
  );

  await t.test(
    'by username: only live public pages are found or invited, with no contact details',
    async () => {
      const business = await setUp();
      await person(database, { handle: 'kemi', email: 'kemi@example.com' });
      await person(database, { handle: 'kemisola', pageState: 'not_live' });
      await person(database, { handle: 'kemi_s', status: 'suspended' });
      await person(database, { handle: 'kemiq', visibility: 'hidden' });
      await person(database, { handle: 'kemidel', pageState: 'deleted' });
      const found = await searchInvitees(
        database.db,
        TOBI.userId,
        business.businessId,
        '@Kemi',
      );
      assert.deepEqual(found, [{ handle: 'kemi', displayName: 'Kemi Person' }]);
      // The LIKE wildcard is escaped.
      assert.deepEqual(
        await searchInvitees(
          database.db,
          TOBI.userId,
          business.businessId,
          'k_mi',
        ),
        [],
      );
      // Not a manager: not found.
      await rejects(
        searchInvitees(database.db, ADA.userId, business.businessId, 'kemi'),
        'NOT_A_MANAGER',
      );
      for (const handle of ['kemisola', 'kemi_s', 'kemiq', 'kemidel', 'nobody'])
        await rejects(
          inviteToBusiness(
            database.db,
            sealing,
            TOBI.userId,
            business.businessId,
            {
              kind: 'staff',
              locationId: business.locations[0].id,
              target: { kind: 'user', handle },
            },
          ),
          'INVITEE_UNAVAILABLE',
        );
    },
  );

  await t.test(
    'by username: a notification, an email to the confirmed address, accept or decline on Work',
    async () => {
      const business = await setUp();
      const kemi = await person(database, {
        handle: 'kemi',
        email: 'kemi@example.com',
      });
      const invite = () =>
        inviteToBusiness(
          database.db,
          sealing,
          TOBI.userId,
          business.businessId,
          {
            kind: 'staff',
            locationId: business.locations[0].id,
            target: { kind: 'user', handle: 'kemi' },
          },
        );
      const first = await invite();
      // The same open invitation again is not sent twice.
      assert.equal((await invite()).id, first.id);
      assert.equal(await database.count('notifications'), 1);
      assert.equal(await database.count('mail_messages'), 1);
      // No email when the address isn't confirmed: Ada has none.
      await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'staff',
          locationId: business.locations[0].id,
          target: { kind: 'user', handle: 'ada' },
        },
      );
      assert.equal(await database.count('notifications'), 2);
      assert.equal(await database.count('mail_messages'), 1);
      // Someone else can't answer Kemi's invitation by id.
      await rejects(
        declineBusinessInvitation(database.db, ADA.userId, {
          invitationId: first.id,
        }),
        'INVITATION_INVALID',
      );
      await declineBusinessInvitation(database.db, kemi.userId, {
        invitationId: first.id,
      });
      const rows = await listBusinessInvitations(
        database.db,
        TOBI.userId,
        business.businessId,
      );
      const row = rows.find((r) => r.id === first.id);
      assert.equal(row.state, 'declined');
      assert.equal(row.handle, 'kemi');
      assert.equal(row.target, 'user');
      assert.equal(row.email, undefined);
    },
  );

  await t.test(
    'the invited person can block a business: invitations stop, by username refused, by email silent',
    async () => {
      const business = await setUp();
      const kemi = await person(database, {
        handle: 'kemi',
        email: 'kemi@example.com',
      });
      const open = await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'staff',
          locationId: business.locations[0].id,
          target: { kind: 'user', handle: 'kemi' },
        },
      );
      await setInvitationBlock(
        database.db,
        kemi.userId,
        business.businessId,
        true,
      );
      // Blocking declines what was open.
      const [row] = await q(
        `SELECT declined_at FROM business_invitations WHERE id = $1`,
        [open.id],
      );
      assert.ok(row.declined_at);
      assert.deepEqual(await myInvitations(database.db, kemi.userId), {
        invitations: [],
        blocked: [
          { businessId: business.businessId, name: 'The Yellow Chilli' },
        ],
      });
      await rejects(
        inviteToBusiness(
          database.db,
          sealing,
          TOBI.userId,
          business.businessId,
          {
            kind: 'staff',
            locationId: business.locations[1].id,
            target: { kind: 'user', handle: 'kemi' },
          },
        ),
        'INVITATIONS_BLOCKED',
      );
      const mailsBefore = await database.count('mail_messages');
      const notesBefore = await database.count('notifications');
      // By email: made, so the business can't tell whether the address has an account, but
      // nobody is told.
      const byEmail = await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'staff',
          locationId: business.locations[1].id,
          target: { kind: 'email', email: 'kemi@example.com' },
        },
      );
      assert.ok(byEmail.id);
      assert.equal(await database.count('mail_messages'), mailsBefore);
      assert.equal(await database.count('notifications'), notesBefore);
      assert.equal(
        (await myBusinessRoles(database.db, kemi.userId)).invitations,
        0,
      );
      // Allowed again.
      await setInvitationBlock(
        database.db,
        kemi.userId,
        business.businessId,
        false,
      );
      await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'staff',
          locationId: business.locations[0].id,
          target: { kind: 'user', handle: 'kemi' },
        },
      );
      await rejects(
        setInvitationBlock(database.db, kemi.userId, randomUUID(), true),
        'BUSINESS_NOT_FOUND',
      );
    },
  );

  await t.test(
    'accepting with a page that is not live: MEMBER_NOT_TIPPABLE, invitation stays open',
    async () => {
      const business = await setUp();
      const created = await staffLink(business);
      const code = codeOf(created.link);
      await q(`UPDATE profiles SET page_state = 'not_live' WHERE id = $1`, [
        ADA.id,
      ]);
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, { code }),
        'MEMBER_NOT_TIPPABLE',
      );
      await q(`UPDATE profiles SET page_state = 'live' WHERE id = $1`, [
        ADA.id,
      ]);
      const accepted = await acceptBusinessInvitation(database.db, ADA.userId, {
        code,
      });
      assert.equal(accepted.kind, 'staff');
      // Already on that team: a second link says so, and stays open.
      const again = await staffLink(business);
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, {
          code: codeOf(again.link),
        }),
        'ALREADY_A_MEMBER',
      );
      assert.equal(
        (
          await listBusinessInvitations(
            database.db,
            TOBI.userId,
            business.businessId,
          )
        ).find((r) => r.id === again.id).state,
        'open',
      );
    },
  );

  await t.test(
    'a location manager can invite staff to their location only; only owners invite managers',
    async () => {
      const business = await setUp();
      const [vi, ikoyi] = business.locations;
      await seedManager(database, {
        businessId: business.businessId,
        userId: ADA.userId,
        locationId: vi.id,
      });
      const mine = await inviteToBusiness(
        database.db,
        sealing,
        ADA.userId,
        business.businessId,
        { kind: 'staff', locationId: vi.id, target: { kind: 'link' } },
      );
      assert.ok(mine.link);
      await rejects(
        inviteToBusiness(
          database.db,
          sealing,
          ADA.userId,
          business.businessId,
          {
            kind: 'staff',
            locationId: ikoyi.id,
            target: { kind: 'link' },
          },
        ),
        'NOT_A_MANAGER',
      );
      await rejects(
        inviteToBusiness(
          database.db,
          sealing,
          ADA.userId,
          business.businessId,
          {
            kind: 'manager',
            role: 'location_manager',
            locationId: vi.id,
            target: { kind: 'link' },
          },
        ),
        'OWNER_REQUIRED',
      );
      // Another business's location, through this business: not found.
      const other = await seedBusiness(database, { owner: TOBI.userId });
      await rejects(
        inviteToBusiness(
          database.db,
          sealing,
          TOBI.userId,
          business.businessId,
          {
            kind: 'staff',
            locationId: other.locations[0].id,
            target: { kind: 'link' },
          },
        ),
        'NOT_A_MANAGER',
      );
      // A location manager sees only their location's staff invitations.
      const ownerOnly = await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        { kind: 'manager', role: 'owner', target: { kind: 'link' } },
      );
      const ikoyiStaff = await staffLink(business, ikoyi.id);
      const seen = (
        await listBusinessInvitations(
          database.db,
          ADA.userId,
          business.businessId,
        )
      ).map((r) => r.id);
      assert.deepEqual(seen, [mine.id]);
      await rejects(
        revokeBusinessInvitation(
          database.db,
          ADA.userId,
          business.businessId,
          ikoyiStaff.id,
        ),
        'NOT_A_MANAGER',
      );
      // An owner invitation makes an owner.
      const kemi = await person(database, { handle: 'kemi' });
      const made = await acceptBusinessInvitation(database.db, kemi.userId, {
        code: codeOf(ownerOnly.link),
      });
      assert.deepEqual(made, {
        kind: 'manager',
        businessId: business.businessId,
      });
      const [seat] = await q(
        `SELECT role, location_id, added_by FROM business_managers WHERE user_id = $1`,
        [kemi.userId],
      );
      assert.deepEqual(seat, {
        role: 'owner',
        location_id: null,
        added_by: TOBI.userId,
      });
      // Managing already: ALREADY_A_MEMBER.
      const second = await inviteToBusiness(
        database.db,
        sealing,
        TOBI.userId,
        business.businessId,
        {
          kind: 'manager',
          role: 'location_manager',
          locationId: vi.id,
          target: { kind: 'link' },
        },
      );
      await rejects(
        acceptBusinessInvitation(database.db, kemi.userId, {
          code: codeOf(second.link),
        }),
        'ALREADY_A_MEMBER',
      );
    },
  );

  await t.test(
    'a paused business invites nobody, and its invitations can no longer be answered',
    async () => {
      const business = await setUp();
      const created = await staffLink(business);
      await q(
        `UPDATE businesses SET status = 'suspended', suspended_at = now(), suspended_reason = 'x' WHERE id = $1`,
        [business.businessId],
      );
      await rejects(staffLink(business), 'BUSINESS_NOT_VERIFIED');
      await rejects(
        acceptBusinessInvitation(database.db, ADA.userId, {
          code: codeOf(created.link),
        }),
        'INVITATION_INVALID',
      );
      // A business still waiting for verification may build its team.
      const pending = await seedBusiness(database, {
        owner: TOBI.userId,
        status: 'pending',
      });
      const early = await staffLink(pending);
      assert.equal(
        (
          await previewBusinessInvitation(database.db, ADA.userId, {
            code: codeOf(early.link),
          })
        ).verified,
        false,
      );
    },
  );

  await t.test(
    'a member seeded elsewhere is unaffected by invitations',
    async () => {
      const business = await setUp();
      await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA.id,
      });
      await rejects(
        inviteToBusiness(
          database.db,
          sealing,
          TOBI.userId,
          business.businessId,
          {
            kind: 'staff',
            locationId: business.locations[0].id,
            target: { kind: 'user', handle: 'ada' },
          },
        ),
        'ALREADY_A_MEMBER',
      );
    },
  );
});
