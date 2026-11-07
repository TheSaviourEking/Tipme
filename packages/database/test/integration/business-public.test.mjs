import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  beginPaymentAccountCreation,
  publicBusiness,
  publicLocation,
  publicStaffTipPage,
  searchBusinessPeople,
  updatePaymentAccountStatus,
} from '../../dist/index.js';
import { leaveMember, seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B4 Task 14: what a supporter sees after scanning a code. Only people who
// can take a tip right now (M3), first names and chosen photos only, nothing else of their page.

const bachs = { provider: 'bachs', environment: 'sandbox' };
const HOUR = 3_600_000;

test('business public reads', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) => database.pool.query(text, values);
  /** Another live page, with its own account. */
  const person = async (handle, displayName, extra = {}) => {
    const userId = randomUUID();
    const profileId = randomUUID();
    await q(`INSERT INTO users (id) VALUES ($1)`, [userId]);
    await q(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, avatar_path, status, page_state, visibility)
       VALUES ($1, $2, $3, lower($3), $4, $5, $6, $7, 'public')`,
      [
        profileId,
        userId,
        handle,
        displayName,
        extra.avatarPath ?? null,
        extra.status ?? 'active',
        extra.pageState ?? 'live',
      ],
    );
    return profileId;
  };
  const shiftAt = (memberId, startedAt, endedAt = null) =>
    q(
      `INSERT INTO business_shifts (id, member_id, started_at, started_by, ended_at, ended_by)
       VALUES ($1, $2, $3, 'self', $4, $5)`,
      [randomUUID(), memberId, startedAt, endedAt, endedAt ? 'self' : null],
    );

  await t.test(
    'the location page lists on-shift people first, then everyone, first names and chosen photos only',
    async () => {
      await database.fresh();
      const now = new Date();
      const business = await seedBusiness(database, {
        name: 'The Yellow Chilli',
        locations: [{ slug: 'vi', name: 'Victoria Island' }],
      });
      const vi = business.locations[0].id;
      const zara = await person('zara', 'Zara Bello', {
        avatarPath: '/portraits/zara.webp',
      });
      const bisi = await person('bisi', 'Bisi Lawal');
      const chidi = await person('chidi', 'Chidi Eze');
      // Ada on shift since two hours ago, Tobi since one: Ada first. Then the rest by name.
      const ada = await seedMember(database, {
        locationId: vi,
        profileId: ADA,
        shownName: 'Ada',
      });
      await shiftAt(ada.memberId, new Date(now.getTime() - 2 * HOUR));
      const tobi = await seedMember(database, {
        locationId: vi,
        profileId: TOBI,
        shownName: 'Tobi',
      });
      await shiftAt(tobi.memberId, new Date(now.getTime() - HOUR));
      const zaraMember = await seedMember(database, {
        locationId: vi,
        profileId: zara,
        shownName: 'Zara',
      });
      const bisiMember = await seedMember(database, {
        locationId: vi,
        profileId: bisi,
        shownName: 'Bisi',
      });
      // Bisi's shift ended; Chidi's is older than 14 hours (it ended by itself, M4).
      await shiftAt(
        bisiMember.memberId,
        new Date(now.getTime() - 3 * HOUR),
        new Date(now.getTime() - HOUR),
      );
      const chidiMember = await seedMember(database, {
        locationId: vi,
        profileId: chidi,
        shownName: 'Chidi',
      });
      await shiftAt(chidiMember.memberId, new Date(now.getTime() - 15 * HOUR));
      // Tobi chose no photo; Bisi has none.
      await q(`UPDATE business_members SET show_photo = false WHERE id = $1`, [
        tobi.memberId,
      ]);

      const page = await publicLocation(
        database.db,
        business.slug.toUpperCase(),
        'VI',
        {},
        now,
      );
      assert.deepEqual(page, {
        business: {
          slug: business.slug,
          name: 'The Yellow Chilli',
          verified: true,
        },
        location: { slug: 'vi', name: 'Victoria Island' },
        people: [
          {
            memberId: ada.memberId,
            handle: 'ada',
            shownName: 'Ada',
            avatarPath: '/portraits/ada.webp',
            onShift: true,
          },
          {
            memberId: tobi.memberId,
            handle: 'tobi',
            shownName: 'Tobi',
            onShift: true,
          },
          {
            memberId: bisiMember.memberId,
            handle: 'bisi',
            shownName: 'Bisi',
            onShift: false,
          },
          {
            memberId: chidiMember.memberId,
            handle: 'chidi',
            shownName: 'Chidi',
            onShift: false,
          },
          {
            memberId: zaraMember.memberId,
            handle: 'zara',
            shownName: 'Zara',
            avatarPath: '/portraits/zara.webp',
            onShift: false,
          },
        ],
      });
    },
  );

  await t.test(
    'a person whose page is not live, or not accepting tips, is not listed',
    async () => {
      await database.fresh();
      const business = await seedBusiness(database);
      const vi = business.locations[0].id;
      const hidden = await person('hidden', 'Hidden One', {
        pageState: 'not_live',
      });
      const suspended = await person('paused', 'Paused One', {
        status: 'suspended',
      });
      const left = await person('gone', 'Gone One');
      for (const [profileId, shownName] of [
        [ADA, 'Ada'],
        [TOBI, 'Tobi'],
        [hidden, 'Hidden'],
        [suspended, 'Paused'],
        [left, 'Gone'],
      ])
        await seedMember(database, { locationId: vi, profileId, shownName });
      const { rows } = await q(
        `SELECT id FROM business_members WHERE profile_id = $1`,
        [left],
      );
      await leaveMember(database, rows[0].id);
      const names = async (options = {}) =>
        (
          await publicLocation(database.db, business.slug, 'vi', options)
        ).people.map((card) => card.shownName);
      assert.deepEqual(await names(), ['Ada', 'Tobi']);
      // A provider that needs the person's own account: only Tobi has one ready.
      await beginPaymentAccountCreation(database.db, {
        profileId: TOBI,
        ...bachs,
      });
      await updatePaymentAccountStatus(database.db, {
        profileId: TOBI,
        ...bachs,
        providerAccountReference: 'acct_tobi',
        status: 'ACTIVE',
        chargesEnabled: true,
        payoutsEnabled: false,
        feeCollector: 'platform',
        requirementsDue: [],
      });
      assert.deepEqual(await names({ requiredAccount: bachs }), ['Tobi']);
    },
  );

  await t.test('pending, suspended, closed: null', async () => {
    await database.fresh();
    const pending = await seedBusiness(database, { status: 'pending' });
    const suspended = await seedBusiness(database, { status: 'suspended' });
    const verified = await seedBusiness(database, {
      locations: [{ slug: 'vi' }, { slug: 'ikoyi', closed: true }],
    });
    for (const business of [pending, suspended, verified])
      await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA,
      });
    assert.equal(await publicLocation(database.db, pending.slug, 'vi'), null);
    assert.equal(await publicLocation(database.db, suspended.slug, 'vi'), null);
    assert.equal(
      await publicLocation(database.db, verified.slug, 'ikoyi'),
      null,
    );
    assert.equal(
      await publicLocation(database.db, verified.slug, 'nowhere'),
      null,
    );
    assert.equal(await publicLocation(database.db, 'no-such', 'vi'), null);
    assert.equal(await publicLocation(database.db, "'; --", 'vi'), null);
    assert.ok(await publicLocation(database.db, verified.slug, 'vi'));
    // With nobody tippable, the page is still there, empty.
    const empty = await seedBusiness(database);
    assert.deepEqual(
      (await publicLocation(database.db, empty.slug, 'vi')).people,
      [],
    );
  });

  await t.test(
    'search finds a person at another location of the business, never at another business',
    async () => {
      await database.fresh();
      const business = await seedBusiness(database, {
        locations: [
          { slug: 'vi', name: 'Victoria Island' },
          { slug: 'ikoyi', name: 'Ikoyi' },
          { slug: 'lekki', name: 'Lekki', closed: true },
        ],
      });
      const other = await seedBusiness(database, { name: 'Other Place' });
      const [vi, ikoyi, lekki] = business.locations;
      const tobi = await seedMember(database, {
        locationId: ikoyi.id,
        profileId: TOBI,
        shownName: 'Tobi',
        onShift: true,
      });
      await seedMember(database, {
        locationId: lekki.id,
        profileId: ADA,
        shownName: 'Tolu',
      });
      await seedMember(database, {
        locationId: other.locations[0].id,
        profileId: ADA,
        shownName: 'Toyin',
      });
      await seedMember(database, {
        locationId: vi.id,
        profileId: ADA,
        shownName: 'Ada',
      });
      assert.deepEqual(
        await searchBusinessPeople(database.db, business.slug, ' to '),
        [
          {
            memberId: tobi.memberId,
            handle: 'tobi',
            shownName: 'Tobi',
            avatarPath: '/portraits/tobi.webp',
            onShift: true,
            locationSlug: 'ikoyi',
            locationName: 'Ikoyi',
          },
        ],
      );
      // Case does not matter; a prefix of the shown name, not the middle of it.
      assert.equal(
        (await searchBusinessPeople(database.db, business.slug, 'TOB')).length,
        1,
      );
      assert.deepEqual(
        await searchBusinessPeople(database.db, business.slug, 'obi'),
        [],
      );
      // One letter is not a search; LIKE wildcards are only letters.
      assert.deepEqual(
        await searchBusinessPeople(database.db, business.slug, 't'),
        [],
      );
      assert.deepEqual(
        await searchBusinessPeople(database.db, business.slug, '%%'),
        [],
      );
      assert.deepEqual(
        await searchBusinessPeople(database.db, business.slug, '__'),
        [],
      );
      // A paused business finds nobody.
      const paused = await seedBusiness(database, { status: 'suspended' });
      await seedMember(database, {
        locationId: paused.locations[0].id,
        profileId: TOBI,
      });
      assert.deepEqual(
        await searchBusinessPeople(database.db, paused.slug, 'tobi'),
        [],
      );
    },
  );

  await t.test('search returns at most 20 people', async () => {
    await database.fresh();
    const business = await seedBusiness(database);
    for (let i = 0; i < 25; i += 1) {
      const profileId = await person(
        `sam_${i}`,
        `Sam ${String(i).padStart(2, '0')}`,
      );
      await seedMember(database, {
        locationId: business.locations[0].id,
        profileId,
        shownName: `Sam ${String(i).padStart(2, '0')}`,
      });
    }
    const found = await searchBusinessPeople(database.db, business.slug, 'sa');
    assert.equal(found.length, 20);
    assert.equal(found[0].shownName, 'Sam 00');
  });

  await t.test(
    'the staff page of someone who left redirects to their own page; an old handle resolves',
    async () => {
      await database.fresh();
      const business = await seedBusiness(database, {
        name: 'The Yellow Chilli',
        locations: [{ slug: 'vi', name: 'Victoria Island' }],
      });
      const vi = business.locations[0].id;
      const tobi = await seedMember(database, {
        locationId: vi,
        profileId: TOBI,
        shownName: 'Tobi',
        onShift: true,
      });
      const page = await publicStaffTipPage(
        database.db,
        business.slug,
        'vi',
        '@Tobi',
        {},
      );
      assert.deepEqual(page, {
        business: {
          slug: business.slug,
          name: 'The Yellow Chilli',
          verified: true,
        },
        location: { slug: 'vi', name: 'Victoria Island' },
        person: {
          memberId: tobi.memberId,
          handle: 'tobi',
          shownName: 'Tobi',
          avatarPath: '/portraits/tobi.webp',
          onShift: true,
        },
        profile: {
          handle: 'tobi',
          displayName: 'Tobi Adeyemi',
          tipAmounts: page.profile.tipAmounts,
          acceptingTips: true,
          plan: 'free',
        },
      });
      assert.ok(page.profile.tipAmounts);

      // Renamed: the old handle still opens the staff page, under the current handle.
      await q(
        `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('tobi_old', $1)`,
        [TOBI],
      );
      assert.equal(
        (
          await publicStaffTipPage(
            database.db,
            business.slug,
            'vi',
            'tobi_old',
            {},
          )
        ).person.handle,
        'tobi',
      );

      // Not accepting tips: the page is there, and says so (the form shows "not ready").
      assert.equal(
        (
          await publicStaffTipPage(database.db, business.slug, 'vi', 'tobi', {
            requiredAccount: bachs,
          })
        ).profile.acceptingTips,
        false,
      );

      // Never a member here, or left: their own page, unlabelled (M2).
      assert.deepEqual(
        await publicStaffTipPage(database.db, business.slug, 'vi', 'ada', {}),
        { redirectTo: '/@ada' },
      );
      await leaveMember(database, tobi.memberId);
      assert.deepEqual(
        await publicStaffTipPage(database.db, business.slug, 'vi', 'tobi', {}),
        { redirectTo: '/@tobi' },
      );
      assert.deepEqual(
        await publicStaffTipPage(
          database.db,
          business.slug,
          'vi',
          'tobi_old',
          {},
        ),
        { redirectTo: '/@tobi' },
      );
    },
  );

  await t.test(
    'a paused business or a closed location sends a staff code to the person’s own page; pending and unknown are null',
    async () => {
      await database.fresh();
      const suspended = await seedBusiness(database, { status: 'suspended' });
      await seedMember(database, {
        locationId: suspended.locations[0].id,
        profileId: TOBI,
      });
      assert.deepEqual(
        await publicStaffTipPage(database.db, suspended.slug, 'vi', 'tobi', {}),
        { redirectTo: '/@tobi' },
      );
      const closed = await seedBusiness(database, {
        locations: [{ slug: 'vi', closed: true }],
      });
      await seedMember(database, {
        locationId: closed.locations[0].id,
        profileId: TOBI,
      });
      assert.deepEqual(
        await publicStaffTipPage(database.db, closed.slug, 'vi', 'tobi', {}),
        { redirectTo: '/@tobi' },
      );
      const pending = await seedBusiness(database, { status: 'pending' });
      await seedMember(database, {
        locationId: pending.locations[0].id,
        profileId: TOBI,
      });
      assert.equal(
        await publicStaffTipPage(database.db, pending.slug, 'vi', 'tobi', {}),
        null,
      );
      const verified = await seedBusiness(database);
      assert.equal(
        await publicStaffTipPage(database.db, 'no-such', 'vi', 'tobi', {}),
        null,
      );
      assert.equal(
        await publicStaffTipPage(
          database.db,
          verified.slug,
          'nope',
          'tobi',
          {},
        ),
        null,
      );
      assert.equal(
        await publicStaffTipPage(
          database.db,
          verified.slug,
          'vi',
          'nobody',
          {},
        ),
        null,
      );
      // A page that is not live is never shown, nor redirected to.
      const hidden = await person('hiddenp', 'Hidden P', {
        pageState: 'not_live',
      });
      await seedMember(database, {
        locationId: verified.locations[0].id,
        profileId: hidden,
      });
      assert.equal(
        await publicStaffTipPage(
          database.db,
          verified.slug,
          'vi',
          'hiddenp',
          {},
        ),
        null,
      );
    },
  );

  await t.test(
    'the business page: a verified business and its open locations in the order they were added, no people',
    async () => {
      await database.fresh();
      const business = await seedBusiness(database, {
        name: 'The Yellow Chilli',
        locations: [
          {
            slug: 'vi',
            name: 'Victoria Island',
            address: '12 Akin Adesola Street, Victoria Island',
          },
          { slug: 'gone', name: 'Old Branch', closed: true },
          { slug: 'lekki', name: 'Lekki Phase 1', address: '4 Admiralty Way' },
        ],
      });
      await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: TOBI,
        shownName: 'Tobi',
      });
      const page = await publicBusiness(
        database.db,
        business.slug.toUpperCase(),
      );
      assert.deepEqual(page, {
        business: {
          slug: business.slug,
          name: 'The Yellow Chilli',
          verified: true,
        },
        locations: [
          {
            slug: 'vi',
            name: 'Victoria Island',
            address: '12 Akin Adesola Street, Victoria Island',
          },
          { slug: 'lekki', name: 'Lekki Phase 1', address: '4 Admiralty Way' },
        ],
      });
      assert.doesNotMatch(JSON.stringify(page), /Tobi/);

      // Waiting, paused, every location closed, unknown or a bad slug: nothing at all.
      const pending = await seedBusiness(database, { status: 'pending' });
      const paused = await seedBusiness(database, { status: 'suspended' });
      const closed = await seedBusiness(database, {
        locations: [{ slug: 'vi', closed: true }],
      });
      for (const slug of [
        pending.slug,
        paused.slug,
        closed.slug,
        'no-such-business',
        'not a slug',
      ])
        assert.equal(await publicBusiness(database.db, slug), null, slug);
    },
  );
});
