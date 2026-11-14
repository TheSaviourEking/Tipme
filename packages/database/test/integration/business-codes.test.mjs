import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessCodes, DEMO_PROFILES } from '../../dist/index.js';
import {
  leaveMember,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B8: the codes a manager may print. Nothing prints before TipMe verifies
// the business (M12); then every open location in the manager's scope and each active member.

const ADA_USER = DEMO_PROFILES[0].userId;
const TOBI_USER = DEMO_PROFILES[1].userId;

const codeOf = async (db, userId, businessId) =>
  businessCodes(db, userId, businessId).then(
    (codes) => ({ ok: true, codes }),
    (error) => ({ ok: false, code: error.code }),
  );

test('business codes', async (t) => {
  const database = await useDatabase(t);

  await t.test(
    'codes are refused until verified; then list each location and each active member',
    async () => {
      await database.fresh();
      for (const status of ['pending', 'suspended']) {
        const { businessId } = await seedBusiness(database, { status });
        assert.deepEqual(await codeOf(database.db, ADA_USER, businessId), {
          ok: false,
          code: 'BUSINESS_NOT_VERIFIED',
        });
      }
      const { businessId, slug, locations } = await seedBusiness(database, {
        slug: 'yellow-chilli',
        locations: [
          { slug: 'vi', name: 'Victoria Island' },
          { slug: 'ikeja', name: 'Ikeja' },
          { slug: 'old', name: 'Old Yaba', closed: true },
        ],
      });
      const [vi, ikeja, old] = locations;
      const tobi = await seedMember(database, {
        locationId: vi.id,
        profileId: TOBI,
        shownName: 'Tobi',
      });
      const ada = await seedMember(database, {
        locationId: ikeja.id,
        profileId: ADA,
        shownName: 'Ada',
      });
      await seedMember(database, { locationId: old.id, profileId: ADA });
      const { codes } = await codeOf(database.db, ADA_USER, businessId);
      assert.deepEqual(codes, {
        // No logo: the sign's tile shows the initial.
        business: { name: 'The Yellow Chilli', slug },
        location: [
          {
            locationId: ikeja.id,
            slug: 'ikeja',
            name: 'Ikeja',
            path: '/b/yellow-chilli/ikeja?src=qr',
          },
          {
            locationId: vi.id,
            slug: 'vi',
            name: 'Victoria Island',
            path: '/b/yellow-chilli/vi?src=qr',
          },
        ],
        staff: [
          {
            memberId: ada.memberId,
            locationId: ikeja.id,
            shownName: 'Ada',
            path: '/b/yellow-chilli/ikeja/ada?src=qr',
          },
          {
            memberId: tobi.memberId,
            locationId: vi.id,
            shownName: 'Tobi',
            path: '/b/yellow-chilli/vi/tobi?src=qr',
          },
        ],
      });
      // With a logo, the codes carry it for the sign's tile.
      const logoPath = `/v1/business-logos/${businessId}/1.webp`;
      await database.pool.query(
        'UPDATE businesses SET logo_path = $2 WHERE id = $1',
        [businessId, logoPath],
      );
      assert.deepEqual(
        (await codeOf(database.db, ADA_USER, businessId)).codes.business,
        { name: 'The Yellow Chilli', slug, logoPath },
      );
    },
  );

  await t.test(
    'a location manager gets only their location; anyone else gets not found',
    async () => {
      await database.fresh();
      const { businessId, locations } = await seedBusiness(database, {
        locations: [{ slug: 'vi' }, { slug: 'ikeja' }],
      });
      await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      await seedMember(database, {
        locationId: locations[1].id,
        profileId: TOBI,
      });
      const other = await seedBusiness(database, { owner: TOBI_USER });
      assert.deepEqual(await codeOf(database.db, ADA_USER, other.businessId), {
        ok: false,
        code: 'NOT_A_MANAGER',
      });
      assert.deepEqual(await codeOf(database.db, ADA_USER, 'not-a-uuid'), {
        ok: false,
        code: 'NOT_A_MANAGER',
      });
      await seedManager(database, {
        businessId,
        userId: TOBI_USER,
        locationId: locations[1].id,
      });
      const { codes } = await codeOf(database.db, TOBI_USER, businessId);
      assert.deepEqual(
        codes.location.map((entry) => entry.slug),
        ['ikeja'],
      );
      assert.deepEqual(
        codes.staff.map((entry) => entry.locationId),
        [locations[1].id],
      );
    },
  );

  await t.test(
    'a member who left has no badge; neither does a suspended page',
    async () => {
      await database.fresh();
      const { businessId, locations } = await seedBusiness(database);
      const left = await seedMember(database, {
        locationId: locations[0].id,
        profileId: TOBI,
      });
      const stays = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
        shownName: 'Ada',
      });
      await leaveMember(database, left.memberId);
      let { codes } = await codeOf(database.db, ADA_USER, businessId);
      assert.deepEqual(
        codes.staff.map((entry) => entry.memberId),
        [stays.memberId],
      );
      // Joining again is a new membership, and so a new badge.
      const back = await seedMember(database, {
        locationId: locations[0].id,
        profileId: TOBI,
      });
      await database.pool.query(
        `UPDATE profiles SET status = 'suspended', suspended_reason = 'Test' WHERE id = $1`,
        [ADA],
      );
      ({ codes } = await codeOf(database.db, ADA_USER, businessId));
      assert.deepEqual(
        codes.staff.map((entry) => entry.memberId),
        [back.memberId],
      );
      // The location's own code never depends on who works there.
      assert.equal(codes.location.length, 1);
    },
  );
});
