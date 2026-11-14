import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  addLocation,
  applyForBusiness,
  businessDetail,
  closeLocation,
  DEMO_PROFILES,
  listManagers,
  mailSealing,
  removeManager,
  tippableMember,
  updateBusiness,
  updateLocation,
} from '../../dist/index.js';
import { seedBusiness, seedManager, seedMember } from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';
import { queuedMail } from '../../dist/test-support.js';

// TipMe for businesses, PR B1 Task 6: applying for a business, its locations and its managers.
// Every refusal to a stranger reads like an unknown business (access-control rule 2).

const [ADA, TOBI] = DEMO_PROFILES;
const sealing = mailSealing(Buffer.alloc(32, 7));

const application = (overrides = {}) => ({
  name: 'The Yellow Chilli',
  slug: `chilli-${randomUUID().slice(0, 8)}`,
  contactName: 'Funke Akindele',
  contactEmail: 'funke@example.com',
  location: {
    name: 'Victoria Island',
    slug: 'vi',
    address: '27 Ademola Adetokunbo, Lagos',
  },
  ...overrides,
});

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return 'resolved';
};

test('business setup', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  const proveEmail = (userId, email) =>
    q(`UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`, [
      userId,
      email,
    ]);
  const setUp = async () => {
    await database.fresh();
    await proveEmail(ADA.userId, 'ada@example.com');
    await proveEmail(TOBI.userId, 'tobi@example.com');
  };

  await t.test(
    'applying makes a pending business, its first location, the applicant as owner and one business_waiting issue',
    async () => {
      await setUp();
      const input = application();
      const detail = await applyForBusiness(database.db, ADA.userId, input);
      assert.equal(detail.status, 'pending');
      assert.equal(detail.slug, input.slug);
      assert.equal(detail.name, 'The Yellow Chilli');
      assert.equal(detail.slugLocked, false);
      assert.deepEqual(detail.contact, {
        name: 'Funke Akindele',
        email: 'funke@example.com',
      });
      assert.deepEqual(detail.you, { role: 'owner' });
      assert.equal(detail.locations.length, 1);
      assert.deepEqual(
        { ...detail.locations[0], id: undefined },
        {
          id: undefined,
          slug: 'vi',
          name: 'Victoria Island',
          address: '27 Ademola Adetokunbo, Lagos',
          closed: false,
        },
      );
      const [business] = await q(
        `SELECT status, created_by FROM businesses WHERE id = $1`,
        [detail.id],
      );
      assert.deepEqual(business, { status: 'pending', created_by: ADA.userId });
      const managers = await q(
        `SELECT user_id, role, location_id, added_by FROM business_managers WHERE business_id = $1`,
        [detail.id],
      );
      assert.deepEqual(managers, [
        {
          user_id: ADA.userId,
          role: 'owner',
          location_id: null,
          added_by: ADA.userId,
        },
      ]);
      const issues = await q(
        `SELECT kind, status, subject FROM issues WHERE kind = 'business_waiting'`,
      );
      assert.equal(issues.length, 1);
      assert.equal(issues[0].status, 'open');
      assert.equal(issues[0].subject.businessId, detail.id);
      // The summary is plain words: never the business's name or contact.
      const [summary] = await q(
        `SELECT summary FROM issues WHERE kind = 'business_waiting'`,
      );
      assert.doesNotMatch(summary.summary, /Yellow Chilli|funke/i);
    },
  );

  await t.test('applying needs a proven email on the account', async () => {
    await database.fresh();
    assert.equal(
      await codeOf(applyForBusiness(database.db, ADA.userId, application())),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    assert.deepEqual(await q(`SELECT id FROM businesses`), []);
  });

  await t.test(
    'a taken business slug is BUSINESS_SLUG_TAKEN; a taken location slug in the same business is LOCATION_SLUG_TAKEN',
    async () => {
      await setUp();
      const first = await applyForBusiness(
        database.db,
        ADA.userId,
        application({ slug: 'yellow-chilli' }),
      );
      assert.equal(
        await codeOf(
          applyForBusiness(
            database.db,
            TOBI.userId,
            application({ slug: 'yellow-chilli' }),
          ),
        ),
        'BUSINESS_SLUG_TAKEN',
      );
      // Nothing half-made from the refused application.
      assert.equal(
        (await q(`SELECT id FROM businesses`)).length,
        1,
        'only the first business',
      );
      assert.equal(
        (await q(`SELECT id FROM issues WHERE kind = 'business_waiting'`))
          .length,
        1,
      );
      assert.equal(
        await codeOf(
          addLocation(database.db, ADA.userId, first.id, {
            name: 'Another VI',
            slug: 'vi',
            address: 'Somewhere else, Lagos',
          }),
        ),
        'LOCATION_SLUG_TAKEN',
      );
      // Another business may use the same location slug.
      const other = await applyForBusiness(
        database.db,
        TOBI.userId,
        application({ slug: 'other-place' }),
      );
      assert.equal(other.locations[0].slug, 'vi');
      // Renaming a location onto a sibling's slug is refused the same way.
      const added = await addLocation(database.db, ADA.userId, first.id, {
        name: 'Ikoyi',
        slug: 'ikoyi',
        address: '5 Bourdillon, Lagos',
      });
      const ikoyi = added.locations.find((l) => l.slug === 'ikoyi');
      assert.equal(
        await codeOf(
          updateLocation(database.db, ADA.userId, first.id, ikoyi.id, {
            slug: 'vi',
          }),
        ),
        'LOCATION_SLUG_TAKEN',
      );
      // And the business slug onto another business's.
      assert.equal(
        await codeOf(
          updateBusiness(database.db, ADA.userId, first.id, {
            slug: 'other-place',
          }),
        ),
        'BUSINESS_SLUG_TAKEN',
      );
    },
  );

  await t.test(
    'the slug can change while pending, not once verified (SLUG_LOCKED)',
    async () => {
      await setUp();
      const detail = await applyForBusiness(
        database.db,
        ADA.userId,
        application(),
      );
      const renamed = await updateBusiness(database.db, ADA.userId, detail.id, {
        slug: 'chilli-house',
        name: 'Chilli House',
        contactPhone: '+234 801 234 5678',
      });
      assert.equal(renamed.slug, 'chilli-house');
      assert.equal(renamed.name, 'Chilli House');
      assert.equal(renamed.contact.phone, '+234 801 234 5678');
      const cleared = await updateBusiness(database.db, ADA.userId, detail.id, {
        contactPhone: null,
      });
      assert.equal(cleared.contact.phone, undefined);
      const locationId = detail.locations[0].id;
      await updateLocation(database.db, ADA.userId, detail.id, locationId, {
        slug: 'victoria-island',
      });

      await q(
        `UPDATE businesses SET status = 'verified', verified_at = now(), verified_by = $2 WHERE id = $1`,
        [detail.id, TOBI.userId],
      );
      assert.equal(
        await codeOf(
          updateBusiness(database.db, ADA.userId, detail.id, { slug: 'new' }),
        ),
        'SLUG_LOCKED',
      );
      assert.equal(
        await codeOf(
          updateLocation(database.db, ADA.userId, detail.id, locationId, {
            slug: 'vi',
          }),
        ),
        'SLUG_LOCKED',
      );
      // The name was checked by TipMe: it is locked like the slugs (coordinator ruling, 6 Nov).
      assert.equal(
        await codeOf(
          updateBusiness(database.db, ADA.userId, detail.id, {
            name: 'Someone Else’s Bar',
          }),
        ),
        'BUSINESS_NAME_LOCKED',
      );
      // A suspended business was verified first: still locked.
      await q(
        `UPDATE businesses SET status = 'suspended', suspended_at = now(), suspended_reason = 'x' WHERE id = $1`,
        [detail.id],
      );
      assert.equal(
        await codeOf(
          updateBusiness(database.db, ADA.userId, detail.id, { name: 'New' }),
        ),
        'BUSINESS_NAME_LOCKED',
      );
      await q(
        `UPDATE businesses SET status = 'verified', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
        [detail.id],
      );
      const [kept] = await q(`SELECT name FROM businesses WHERE id = $1`, [
        detail.id,
      ]);
      assert.equal(kept.name, 'Chilli House');
      // The same slug and name again are not changes; other fields still save.
      const verified = await updateBusiness(
        database.db,
        ADA.userId,
        detail.id,
        { slug: 'chilli-house', name: 'Chilli House', contactName: 'Funke A.' },
      );
      assert.equal(verified.slugLocked, true);
      assert.equal(verified.contact.name, 'Funke A.');
      const moved = await updateLocation(
        database.db,
        ADA.userId,
        detail.id,
        locationId,
        { address: '30 Ademola Adetokunbo, Lagos' },
      );
      assert.equal(moved.locations[0].address, '30 Ademola Adetokunbo, Lagos');
      // A location added after verifying chooses its slug once, then it is locked too.
      const added = await addLocation(database.db, ADA.userId, detail.id, {
        name: 'Lekki',
        slug: 'lekki',
        address: 'Admiralty Way, Lagos',
      });
      const lekki = added.locations.find((l) => l.slug === 'lekki');
      assert.equal(
        await codeOf(
          updateLocation(database.db, ADA.userId, detail.id, lekki.id, {
            slug: 'lekki-1',
          }),
        ),
        'SLUG_LOCKED',
      );
    },
  );

  await t.test(
    'a location manager sees and edits only their location; adding a location needs an owner',
    async () => {
      await setUp();
      const { businessId, locations } = await seedBusiness(database, {
        status: 'pending',
        locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
      });
      await seedManager(database, {
        businessId,
        userId: TOBI.userId,
        locationId: locations[1].id,
      });
      const seen = await businessDetail(database.db, TOBI.userId, businessId);
      assert.deepEqual(
        seen.locations.map((l) => l.slug),
        ['ikoyi'],
      );
      assert.deepEqual(seen.you, {
        role: 'location_manager',
        locationId: locations[1].id,
      });
      const owner = await businessDetail(database.db, ADA.userId, businessId);
      assert.deepEqual(owner.locations.map((l) => l.slug).sort(), [
        'ikoyi',
        'vi',
      ]);
      const edited = await updateLocation(
        database.db,
        TOBI.userId,
        businessId,
        locations[1].id,
        { name: 'Ikoyi Lounge' },
      );
      assert.equal(edited.locations[0].name, 'Ikoyi Lounge');
      assert.equal(
        await codeOf(
          updateLocation(
            database.db,
            TOBI.userId,
            businessId,
            locations[0].id,
            {
              name: 'Not mine',
            },
          ),
        ),
        'NOT_A_MANAGER',
      );
      assert.equal(
        await codeOf(
          addLocation(database.db, TOBI.userId, businessId, {
            name: 'Lekki',
            slug: 'lekki',
            address: 'Admiralty Way, Lagos',
          }),
        ),
        'OWNER_REQUIRED',
      );
      assert.equal(
        await codeOf(
          updateBusiness(database.db, TOBI.userId, businessId, {
            name: 'Mine now',
          }),
        ),
        'OWNER_REQUIRED',
      );
      assert.equal(
        await codeOf(
          closeLocation(database.db, TOBI.userId, businessId, locations[1].id),
        ),
        'OWNER_REQUIRED',
      );
    },
  );

  await t.test(
    'another business id answers 404 exactly like an unknown one',
    async () => {
      await setUp();
      const theirs = await seedBusiness(database, { owner: TOBI.userId });
      const unknown = randomUUID();
      for (const businessId of [theirs.businessId, unknown, 'not-a-uuid']) {
        assert.equal(
          await codeOf(businessDetail(database.db, ADA.userId, businessId)),
          'NOT_A_MANAGER',
        );
        assert.equal(
          await codeOf(
            updateBusiness(database.db, ADA.userId, businessId, { name: 'x' }),
          ),
          'NOT_A_MANAGER',
        );
        assert.equal(
          await codeOf(listManagers(database.db, ADA.userId, businessId)),
          'NOT_A_MANAGER',
        );
      }
      // A location of another business, named under one's own, is unknown too.
      const mine = await seedBusiness(database, { status: 'pending' });
      assert.equal(
        await codeOf(
          updateLocation(
            database.db,
            ADA.userId,
            mine.businessId,
            theirs.locations[0].id,
            { name: 'x' },
          ),
        ),
        'NOT_A_MANAGER',
      );
      // A removed manager is a stranger.
      const { managerId } = await seedManager(database, {
        businessId: theirs.businessId,
        userId: ADA.userId,
      });
      await q(`UPDATE business_managers SET removed_at = now() WHERE id = $1`, [
        managerId,
      ]);
      assert.equal(
        await codeOf(
          businessDetail(database.db, ADA.userId, theirs.businessId),
        ),
        'NOT_A_MANAGER',
      );
    },
  );

  await t.test(
    'closing a location ends its open shifts and hides it from the public',
    async () => {
      await setUp();
      const { businessId, locations } = await seedBusiness(database, {
        locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
      });
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: TOBI.id,
        onShift: true,
      });
      const elsewhere = await seedMember(database, {
        locationId: locations[1].id,
        profileId: ADA.id,
        onShift: true,
      });
      assert.ok(await tippableMember(database.db, TOBI.id, memberId));
      const closed = await closeLocation(
        database.db,
        ADA.userId,
        businessId,
        locations[0].id,
      );
      assert.equal(
        closed.locations.find((l) => l.id === locations[0].id).closed,
        true,
      );
      const shifts = await q(
        `SELECT member_id, ended_by, ended_at IS NOT NULL AS ended FROM business_shifts ORDER BY member_id = $1 DESC`,
        [memberId],
      );
      assert.deepEqual(shifts, [
        { member_id: memberId, ended_by: 'manager', ended: true },
        { member_id: elsewhere.memberId, ended_by: null, ended: false },
      ]);
      // The membership stays; the location no longer takes a labelled tip.
      const [member] = await q(
        `SELECT left_at FROM business_members WHERE id = $1`,
        [memberId],
      );
      assert.equal(member.left_at, null);
      assert.equal(await tippableMember(database.db, TOBI.id, memberId), null);
      // Closing again changes nothing.
      const again = await closeLocation(
        database.db,
        ADA.userId,
        businessId,
        locations[0].id,
      );
      assert.equal(
        again.locations.find((l) => l.id === locations[0].id).closed,
        true,
      );
    },
  );

  await t.test(
    'managers are listed; the last owner cannot be removed',
    async () => {
      await setUp();
      const { businessId, locations } = await seedBusiness(database, {
        status: 'pending',
      });
      const [onlyOwner] = await q(
        `SELECT id FROM business_managers WHERE business_id = $1`,
        [businessId],
      );
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            ADA.userId,
            businessId,
            onlyOwner.id,
          ),
        ),
        'BUSINESS_LAST_OWNER',
      );
      const lm = await seedManager(database, {
        businessId,
        userId: TOBI.userId,
        locationId: locations[0].id,
      });
      const listed = await listManagers(database.db, ADA.userId, businessId);
      assert.deepEqual(
        listed.map(({ role, name, you, locationId }) => ({
          role,
          name,
          you,
          locationId,
        })),
        [
          {
            role: 'owner',
            name: 'Ada Okafor',
            you: true,
            locationId: undefined,
          },
          {
            role: 'location_manager',
            name: 'Tobi Adeyemi',
            you: false,
            locationId: locations[0].id,
          },
        ],
      );
      // Only an owner removes; a location manager is refused.
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            TOBI.userId,
            businessId,
            onlyOwner.id,
          ),
        ),
        'OWNER_REQUIRED',
      );
      // A manager id from another business is unknown.
      const other = await seedBusiness(database, { owner: TOBI.userId });
      const [otherOwner] = await q(
        `SELECT id FROM business_managers WHERE business_id = $1`,
        [other.businessId],
      );
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            ADA.userId,
            businessId,
            otherOwner.id,
          ),
        ),
        'NOT_A_MANAGER',
      );
      await removeManager(
        database.db,
        sealing,
        ADA.userId,
        businessId,
        lm.managerId,
      );
      assert.equal(
        await codeOf(businessDetail(database.db, TOBI.userId, businessId)),
        'NOT_A_MANAGER',
      );
      assert.equal(
        (await listManagers(database.db, ADA.userId, businessId)).length,
        1,
      );
      // With a second owner, the first can step down.
      const second = await seedManager(database, {
        businessId,
        userId: TOBI.userId,
      });
      await removeManager(
        database.db,
        sealing,
        ADA.userId,
        businessId,
        onlyOwner.id,
      );
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            TOBI.userId,
            businessId,
            second.managerId,
          ),
        ),
        'BUSINESS_LAST_OWNER',
      );
    },
  );

  await t.test('two owners stepping down at once leave one owner', async () => {
    await setUp();
    const { businessId } = await seedBusiness(database, {
      status: 'pending',
    });
    const [first] = await q(
      `SELECT id FROM business_managers WHERE business_id = $1`,
      [businessId],
    );
    const second = await seedManager(database, {
      businessId,
      userId: TOBI.userId,
    });
    const outcomes = await Promise.allSettled([
      removeManager(database.db, sealing, ADA.userId, businessId, first.id),
      removeManager(
        database.db,
        sealing,
        TOBI.userId,
        businessId,
        second.managerId,
      ),
    ]);
    const owners = await q(
      `SELECT id FROM business_managers WHERE business_id = $1 AND removed_at IS NULL`,
      [businessId],
    );
    assert.equal(owners.length, 1);
    assert.equal(
      outcomes.filter((o) => o.status === 'fulfilled').length,
      1,
      'one stepping down wins',
    );
  });

  // The owner's ruling (14 Nov 2026): an owner never ends another owner's seat; TipMe does it.
  await t.test(
    'an owner removing another owner is refused, audited, and nothing changes',
    async () => {
      await setUp();
      const { businessId } = await seedBusiness(database, {
        status: 'verified',
      });
      const [first] = await q(
        `SELECT id FROM business_managers WHERE business_id = $1`,
        [businessId],
      );
      const second = await seedManager(database, {
        businessId,
        userId: TOBI.userId,
      });
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            ADA.userId,
            businessId,
            second.managerId,
          ),
        ),
        'OWNER_REMOVAL_NEEDS_TIPME',
      );
      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            TOBI.userId,
            businessId,
            first.id,
          ),
        ),
        'OWNER_REMOVAL_NEEDS_TIPME',
      );
      const seats = await q(
        `SELECT id FROM business_managers WHERE business_id = $1 AND removed_at IS NULL`,
        [businessId],
      );
      assert.equal(seats.length, 2);
      assert.deepEqual(
        await q(
          `SELECT action, staff_user_id, subject_type, subject_id FROM audit_events
            WHERE action = 'business.owner_removal_blocked' ORDER BY created_at, id`,
        ),
        [
          {
            action: 'business.owner_removal_blocked',
            staff_user_id: ADA.userId,
            subject_type: 'business',
            subject_id: businessId,
          },
          {
            action: 'business.owner_removal_blocked',
            staff_user_id: TOBI.userId,
            subject_type: 'business',
            subject_id: businessId,
          },
        ],
      );
    },
  );
  // Owner-change emails (owner, 14 Nov 2026): every owner hears, the one asking or leaving included.
  await t.test(
    'a refused owner removal and an owner stepping down email every owner',
    async () => {
      await setUp();
      const { businessId } = await seedBusiness(database, {
        status: 'verified',
        name: 'The Yellow Chilli',
      });
      const [first] = await q(
        `SELECT id FROM business_managers WHERE business_id = $1`,
        [businessId],
      );
      const second = await seedManager(database, {
        businessId,
        userId: TOBI.userId,
      });
      const ownerMail = async () =>
        (await queuedMail(database.db, sealing, { limit: 50 }))
          .filter((mail) => mail.type === 'business_owner_change')
          .map(({ userId, data }) => ({ userId, ...data }))
          .sort((a, b) =>
            `${a.change}${a.userId}`.localeCompare(`${b.change}${b.userId}`),
          );
      const byUser = (rows) =>
        rows.sort((a, b) => a.userId.localeCompare(b.userId));

      assert.equal(
        await codeOf(
          removeManager(
            database.db,
            sealing,
            ADA.userId,
            businessId,
            second.managerId,
          ),
        ),
        'OWNER_REMOVAL_NEEDS_TIPME',
      );
      const blocked = {
        change: 'removal_blocked',
        businessName: 'The Yellow Chilli',
        ownerName: 'Tobi Adeyemi',
        actorName: 'Ada Okafor',
      };
      assert.deepEqual(
        await ownerMail(),
        byUser([
          { userId: ADA.userId, ...blocked, you: 'actor' },
          { userId: TOBI.userId, ...blocked, you: 'owner' },
        ]),
      );

      // Tobi steps down: both hear, Tobi included.
      await removeManager(
        database.db,
        sealing,
        TOBI.userId,
        businessId,
        second.managerId,
      );
      const stepped = (await ownerMail()).filter(
        (mail) => mail.change === 'stepped_down',
      );
      const left = {
        change: 'stepped_down',
        businessName: 'The Yellow Chilli',
        ownerName: 'Tobi Adeyemi',
      };
      assert.deepEqual(
        stepped,
        byUser([
          { userId: ADA.userId, ...left, you: 'other' },
          { userId: TOBI.userId, ...left, you: 'owner' },
        ]),
      );
      // The last owner can't step down, and nobody is emailed about it.
      const before = (await ownerMail()).length;
      assert.equal(
        await codeOf(
          removeManager(database.db, sealing, ADA.userId, businessId, first.id),
        ),
        'BUSINESS_LAST_OWNER',
      );
      assert.equal((await ownerMail()).length, before);
    },
  );
});
