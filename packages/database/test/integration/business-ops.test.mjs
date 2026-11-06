import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  listOpsBusinesses,
  opsBusinessDetail,
  restoreBusiness,
  revealBusinessContact,
  suspendBusiness,
} from '../../dist/index.js';
import { seedBusiness, seedManager, seedMember } from './business-fixtures.mjs';
import { TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B2 Task 8: what staff see of a business, and suspending one.

const TOBI_P = DEMO_PROFILES[1];
const REASON = 'Checked the business on a call today';

test('business ops', async (t) => {
  const database = await useDatabase(t);
  const q = async (text, values) =>
    (await database.pool.query(text, values)).rows;
  const staffId = TOBI_P.userId;

  await t.test(
    'the list and detail mask the contact and give counts only',
    async () => {
      await database.fresh();
      const { businessId, locations } = await seedBusiness(database, {
        status: 'pending',
        slug: 'yellow-chilli',
        locations: [{ slug: 'vi' }, { slug: 'lekki', closed: true }],
      });
      await q(
        `UPDATE businesses SET contact_phone = '+2348031234567' WHERE id = $1`,
        [businessId],
      );
      await seedManager(database, {
        businessId,
        userId: TOBI_P.userId,
        locationId: locations[0].id,
      });
      await seedMember(database, {
        locationId: locations[0].id,
        profileId: TOBI,
      });
      await seedBusiness(database, { status: 'verified', slug: 'other' });

      const all = await listOpsBusinesses(database.db, {});
      assert.equal(all.length, 2);
      const waiting = await listOpsBusinesses(database.db, {
        status: 'pending',
      });
      assert.deepEqual(
        waiting.map((row) => row.slug),
        ['yellow-chilli'],
      );
      const [row] = waiting;
      assert.equal(row.contactEmailMasked, 'f•••@example.com');
      assert.equal(row.contactPhoneLast4, '4567');
      assert.equal(row.locations, 2);
      assert.equal(row.members, 1);
      assert.doesNotMatch(JSON.stringify(row), /funke@|Funke|2348031/);

      // q matches the name or slug, never the contact.
      assert.equal(
        (await listOpsBusinesses(database.db, { q: 'chilli' })).length,
        2,
      );
      assert.equal(
        (await listOpsBusinesses(database.db, { q: 'yellow-ch' })).length,
        1,
      );
      assert.equal(
        (await listOpsBusinesses(database.db, { q: 'funke' })).length,
        0,
      );

      const detail = await opsBusinessDetail(database.db, businessId);
      assert.equal(detail.locationList.length, 2);
      assert.equal(
        detail.locationList.find((l) => l.slug === 'lekki').closed,
        true,
      );
      assert.equal(detail.managers.length, 2);
      for (const manager of detail.managers)
        assert.doesNotMatch(manager.userHint, /^[^•]+@/);
      assert.doesNotMatch(JSON.stringify(detail), /funke@|2348031/);
      await assert.rejects(
        opsBusinessDetail(database.db, '00000000-0000-4000-8000-000000000000'),
        { code: 'BUSINESS_NOT_FOUND' },
      );
    },
  );

  await t.test(
    'a reveal gives the full contact and is audited with the reason',
    async () => {
      await database.fresh();
      const { businessId } = await seedBusiness(database);
      const contact = await revealBusinessContact(database.db, {
        staffUserId: staffId,
        businessId,
        reason: REASON,
      });
      assert.equal(contact.contactEmail, 'funke@example.com');
      assert.equal(contact.contactName, 'Funke');
      assert.equal(contact.managers.length, 1);
      assert.equal(contact.managers[0].role, 'owner');
      const audit = await q(
        `SELECT action, permission, subject_type, reason FROM audit_events WHERE subject_id = $1`,
        [businessId],
      );
      assert.deepEqual(audit, [
        {
          action: 'business.reveal',
          permission: 'private.view',
          subject_type: 'business',
          reason: REASON,
        },
      ]);
    },
  );

  await t.test(
    'suspending ends open shifts as the system, stops attribution, and is audited; restoring brings it back',
    async () => {
      await database.fresh();
      const { businessId, slug, locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: TOBI,
        onShift: true,
      });
      const suspended = await suspendBusiness(database.db, {
        staffUserId: staffId,
        businessId,
        reason: REASON,
      });
      assert.deepEqual(suspended, { slug, changed: true });
      const [row] = await q(
        `SELECT status, suspended_at, suspended_reason FROM businesses WHERE id = $1`,
        [businessId],
      );
      assert.equal(row.status, 'suspended');
      assert.ok(row.suspended_at);
      assert.equal(row.suspended_reason, REASON);
      const shifts = await q(
        `SELECT ended_by FROM business_shifts WHERE member_id = $1`,
        [memberId],
      );
      assert.deepEqual(shifts, [{ ended_by: 'expired' }]);
      // A second suspend changes nothing and records nothing more.
      assert.deepEqual(
        await suspendBusiness(database.db, {
          staffUserId: staffId,
          businessId,
          reason: REASON,
        }),
        { slug, changed: false },
      );

      const restored = await restoreBusiness(database.db, {
        staffUserId: staffId,
        businessId,
        reason: REASON,
      });
      assert.deepEqual(restored, { slug, changed: true });
      const [after] = await q(
        `SELECT status, suspended_at, suspended_reason, verified_at FROM businesses WHERE id = $1`,
        [businessId],
      );
      assert.equal(after.status, 'verified');
      assert.equal(after.suspended_at, null);
      assert.equal(after.suspended_reason, null);
      assert.ok(after.verified_at);
      const audit = await q(
        `SELECT action, permission, reason FROM audit_events WHERE subject_id = $1 ORDER BY seq`,
        [businessId],
      );
      assert.deepEqual(
        audit.map((a) => [a.action, a.permission, a.reason]),
        [
          ['business.suspended', 'businesses.manage', REASON],
          ['business.restored', 'businesses.manage', REASON],
        ],
      );
    },
  );

  await t.test(
    'a waiting business cannot be suspended or restored; an unknown one is BUSINESS_NOT_FOUND',
    async () => {
      await database.fresh();
      const { businessId } = await seedBusiness(database, {
        status: 'pending',
      });
      const input = { staffUserId: staffId, businessId, reason: REASON };
      await assert.rejects(suspendBusiness(database.db, input), {
        code: 'BUSINESS_NOT_VERIFIED',
      });
      await assert.rejects(restoreBusiness(database.db, input), {
        code: 'BUSINESS_NOT_VERIFIED',
      });
      await assert.rejects(
        suspendBusiness(database.db, { ...input, businessId: 'nope' }),
        { code: 'BUSINESS_NOT_FOUND' },
      );
    },
  );
});
