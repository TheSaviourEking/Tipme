import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  grantOwner,
  staffPermissions,
} from '../../dist/index.js';
import { seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B0: what the database itself refuses, so no lane can write it wrongly.

const ADA_USER = DEMO_PROFILES[0].userId;
const refused = (promise, name) =>
  assert.rejects(promise, (error) => {
    assert.match(String(error.constraint ?? error.message), name);
    return true;
  });

test('business schema', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) => database.pool.query(text, values);
  const business = (values) =>
    q(
      `INSERT INTO businesses (id, slug, name, contact_name, contact_email, created_by, status, verified_at, suspended_at, suspended_reason)
       VALUES ($1, $2, $3, 'Funke', 'funke@example.com', $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        values.slug ?? `b-${randomUUID().slice(0, 6)}`,
        values.name ?? 'Shop',
        ADA_USER,
        values.status ?? 'pending',
        values.verifiedAt ?? null,
        values.suspendedAt ?? null,
        values.suspendedReason ?? null,
      ],
    );

  await t.test(
    'a slug that breaks the rule, a duplicate slug, or a second open membership is refused by the database',
    async () => {
      await database.fresh();
      for (const slug of ['-x', 'x-', 'Yellow', 'a_b', 'a'.repeat(41), ''])
        await refused(business({ slug }), /businesses_slug/);
      await business({ slug: 'yellow-chilli' });
      await refused(
        business({ slug: 'yellow-chilli' }),
        /businesses_slug_unique/,
      );
      await refused(business({ name: '' }), /businesses_name/);
      const { businessId, locations } = await seedBusiness(database);
      await refused(
        q(
          `INSERT INTO business_locations (id, business_id, slug, name, address) VALUES ($1, $2, 'vi', 'VI again', 'x')`,
          [randomUUID(), businessId],
        ),
        /business_locations_slug/,
      );
      await refused(
        q(
          `INSERT INTO business_locations (id, business_id, slug, name, address) VALUES ($1, $2, $3, 'Long', 'x')`,
          [randomUUID(), businessId, 'a'.repeat(31)],
        ),
        /business_locations_slug_rule/,
      );
      const locationId = locations[0].id;
      const { memberId } = await seedMember(database, {
        locationId,
        profileId: TOBI,
      });
      await refused(
        seedMember(database, { locationId, profileId: TOBI }),
        /business_members_open/,
      );
      // Once the first has left, the person can join again (a new membership id).
      await q(
        `UPDATE business_members SET left_at = now(), left_by = 'self' WHERE id = $1`,
        [memberId],
      );
      const again = await seedMember(database, { locationId, profileId: TOBI });
      assert.notEqual(again.memberId, memberId);
      await refused(
        q(`UPDATE business_members SET left_at = now() WHERE id = $1`, [
          again.memberId,
        ]),
        /business_members_left/,
      );
    },
  );

  await t.test(
    'statuses: suspended needs a reason and a verification first',
    async () => {
      await database.fresh();
      await refused(business({ status: 'verified' }), /businesses_verified/);
      await refused(
        business({
          status: 'suspended',
          verifiedAt: new Date(),
          suspendedAt: new Date(),
        }),
        /businesses_suspended/,
      );
      await refused(
        business({
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedReason: 'x',
        }),
        /businesses_verified/,
      );
      await refused(
        business({
          status: 'pending',
          suspendedAt: new Date(),
          suspendedReason: 'x',
        }),
        /businesses_suspended/,
      );
      await refused(business({ status: 'closed' }), /businesses_status/);
      await business({
        status: 'suspended',
        verifiedAt: new Date(),
        suspendedAt: new Date(),
        suspendedReason: 'Fake address',
      });
    },
  );

  await t.test(
    'owner managers have no location; location managers must have one',
    async () => {
      await database.fresh();
      const { businessId, locations } = await seedBusiness(database);
      const manager = (role, locationId, userId = DEMO_PROFILES[1].userId) =>
        q(
          `INSERT INTO business_managers (id, business_id, user_id, role, location_id) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), businessId, userId, role, locationId],
        );
      await refused(
        manager('owner', locations[0].id),
        /business_managers_location/,
      );
      await refused(
        manager('location_manager', null),
        /business_managers_location/,
      );
      await refused(manager('boss', locations[0].id), /business_managers_role/);
      await manager('location_manager', locations[0].id);
      // One open manager row per person per business.
      await refused(manager('owner', null), /business_managers_open/);
    },
  );

  await t.test(
    'invitations: email, link or a TipMe username, one outcome',
    async () => {
      await database.fresh();
      const { businessId, locations } = await seedBusiness(database);
      const invite = (values) =>
        q(
          `INSERT INTO business_invitations (id, business_id, location_id, kind, manager_role, target, email_lower, invited_profile_id, code_sha256, invited_by, expires_at, accepted_at, accepted_by, declined_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + interval '7 days', $11, $12, $13)`,
          [
            randomUUID(),
            businessId,
            values.locationId === undefined
              ? locations[0].id
              : values.locationId,
            values.kind ?? 'staff',
            values.role ?? null,
            values.target,
            values.email ?? null,
            values.profileId ?? null,
            randomUUID(),
            ADA_USER,
            values.acceptedAt ?? null,
            values.acceptedBy ?? null,
            values.declinedAt ?? null,
          ],
        );
      await invite({ target: 'link' });
      await invite({ target: 'email', email: 'tobi@example.com' });
      await invite({ target: 'user', profileId: TOBI });
      await refused(invite({ target: 'email' }), /business_invitations_target/);
      await refused(
        invite({ target: 'link', email: 'a@b.co' }),
        /business_invitations_target/,
      );
      await refused(invite({ target: 'user' }), /business_invitations_target/);
      await refused(invite({ target: 'sms' }), /business_invitations_target/);
      await refused(
        invite({ target: 'link', locationId: null }),
        /business_invitations_role/,
      );
      await refused(
        invite({ target: 'link', kind: 'manager', role: 'owner' }),
        /business_invitations_role/,
      );
      await invite({
        target: 'link',
        kind: 'manager',
        role: 'owner',
        locationId: null,
      });
      await invite({
        target: 'link',
        kind: 'manager',
        role: 'location_manager',
      });
      await refused(
        invite({
          target: 'link',
          acceptedAt: new Date(),
          acceptedBy: ADA_USER,
          declinedAt: new Date(),
        }),
        /business_invitations_outcome/,
      );
      await refused(
        invite({ target: 'link', acceptedAt: new Date() }),
        /business_invitations_outcome/,
      );
      // The invited person's block, once per business.
      await q(
        `INSERT INTO business_invitation_blocks (business_id, user_id) VALUES ($1, $2)`,
        [businessId, DEMO_PROFILES[1].userId],
      );
      await refused(
        q(
          `INSERT INTO business_invitation_blocks (business_id, user_id) VALUES ($1, $2)`,
          [businessId, DEMO_PROFILES[1].userId],
        ),
        /business_invitation_blocks/,
      );
    },
  );

  await t.test('one open shift per member', async () => {
    await database.fresh();
    const { locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI,
      onShift: true,
    });
    const shift = (startedBy = 'self') =>
      q(
        `INSERT INTO business_shifts (id, member_id, started_at, started_by) VALUES ($1, $2, now(), $3)`,
        [randomUUID(), memberId, startedBy],
      );
    await refused(shift(), /business_shifts_open/);
    await q(
      `UPDATE business_shifts SET ended_at = now(), ended_by = 'self' WHERE member_id = $1`,
      [memberId],
    );
    await shift('manager');
    await refused(
      q(
        `UPDATE business_shifts SET ended_at = now(), ended_by = 'forgot' WHERE ended_at IS NULL`,
      ),
      /business_shifts_ended/,
    );
    await refused(shift('robot'), /business_shifts_started_by/);
  });

  await t.test(
    'a note needs a tag or text; unknown tags and 281 characters are refused',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const tip = async () => {
        const { quoteId } = await createQuote(database.db, {
          handle: 'ada',
          tipMinor: 200000n,
          currency: 'NGN',
        });
        return (
          await createPaymentIntent(database.db, {
            quoteId,
            idempotencyKey: randomUUID(),
          })
        ).tipId;
      };
      const note = async (tags, body) =>
        q(
          `INSERT INTO business_notes (tip_id, member_id, tags, body) VALUES ($1, $2, $3, $4)`,
          [await tip(), memberId, tags, body],
        );
      await note(['friendly', 'fast'], null);
      await note([], 'Lovely service');
      await note([], '😀'.repeat(280));
      await refused(note([], null), /business_notes_something/);
      await refused(note(['rude'], null), /business_notes_tags/);
      await refused(
        note(
          [
            'friendly',
            'fast',
            'extra_mile',
            'great_advice',
            'made_my_day',
            'fast',
          ],
          null,
        ),
        /business_notes_tags/,
      );
      await refused(note([], 'a'.repeat(281)), /business_notes_body/);
      await refused(note([], ''), /business_notes_body/);
      const reported = await tip();
      await q(
        `INSERT INTO business_notes (tip_id, member_id, tags) VALUES ($1, $2, '{fast}')`,
        [reported, memberId],
      );
      await refused(
        q(
          `INSERT INTO business_note_flags (tip_id, reported_at, reported_by, reason) VALUES ($1, now(), 'member', 'boring')`,
          [reported],
        ),
        /business_note_flags_reported/,
      );
      await q(
        `INSERT INTO business_note_flags (tip_id, reported_at, reported_by, reason) VALUES ($1, now(), 'manager', 'spam')`,
        [reported],
      );
      await refused(
        q(
          `UPDATE business_note_flags SET reviewed_at = now() WHERE tip_id = $1`,
          [reported],
        ),
        /business_note_flags_review/,
      );
    },
  );

  await t.test(
    'tips: member and location are both set or both null',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const { quoteId } = await createQuote(database.db, {
        handle: 'ada',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      const { tipId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
      });
      await refused(
        q(`UPDATE tips SET business_member_id = $2 WHERE id = $1`, [
          tipId,
          memberId,
        ]),
        /tips_business_pair/,
      );
      await refused(
        q(`UPDATE tips SET business_location_id = $2 WHERE id = $1`, [
          tipId,
          locations[0].id,
        ]),
        /tips_business_pair/,
      );
    },
  );

  await t.test(
    'role_permissions accepts businesses.manage; issues and notifications accept the new kinds',
    async () => {
      await database.fresh();
      await refused(
        q(
          `INSERT INTO role_permissions (role_id, permission) VALUES ('owner', 'businesses.own')`,
        ),
        /role_permissions_known/,
      );
      for (const kind of ['business_waiting', 'business_note_reported'])
        await q(
          `INSERT INTO issues (id, kind, severity, status, subject, summary, dedupe_key, opened_at)
         VALUES ($1, $2, 'info', 'open', '{}'::jsonb, 'x', $3, now())`,
          [randomUUID(), kind, `${kind}.${randomUUID()}`],
        );
      const { businessId } = await seedBusiness(database);
      for (const kind of ['business_invitation', 'business_verified'])
        await q(
          `INSERT INTO notifications (id, user_id, kind, business_id, title, body) VALUES ($1, $2, $3, $4, 't', 'b')`,
          [randomUUID(), ADA_USER, kind, businessId],
        );
      await refused(
        q(
          `INSERT INTO notifications (id, user_id, kind, title, body) VALUES ($1, $2, 'business_spam', 't', 'b')`,
          [randomUUID(), ADA_USER],
        ),
        /notifications_kind/,
      );
    },
  );

  await t.test(
    'owner holds businesses.manage after migrating; release_check does not',
    async () => {
      await database.fresh();
      const { userId: ownerId } = await grantOwner(database.db, {
        phone: '+2348037770061',
      });
      await q(
        `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission = 'businesses.manage'`,
      );
      const dir = new URL('../../drizzle/', import.meta.url);
      const file = readdirSync(dir).find((name) =>
        /^\d{4}_business\.sql$/.test(name),
      );
      const migration = readFileSync(new URL(file, dir), 'utf8');
      await q(migration.slice(migration.lastIndexOf('INSERT INTO')));
      const { rows } = await q(
        `SELECT role_id FROM role_permissions WHERE permission = 'businesses.manage' ORDER BY role_id`,
      );
      assert.deepEqual(
        rows.map((r) => r.role_id),
        ['owner'],
      );
      assert.equal(
        (await staffPermissions(database.db, ownerId)).has('businesses.manage'),
        true,
      );
      const { userId } = await grantOwner(database.db, {
        phone: '+2348037770062',
        role: 'release_check',
      });
      assert.equal(
        (await staffPermissions(database.db, userId)).has('businesses.manage'),
        false,
      );
    },
  );
});
