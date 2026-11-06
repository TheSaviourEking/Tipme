import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lagosDateOf, shareStartsAt } from '@tipme/domain';
import {
  acceptShare,
  answerSuggestedShare,
  counterShare,
  declineShare,
  DEMO_PROFILES,
  endShareAgreements,
  listBusinessShares,
  mailSealing,
  myShares,
  proposeShare,
  reportBusiness,
  withdrawShare,
} from '../../dist/index.js';
import {
  leaveMember,
  seedAgreement,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { TOBI, useDatabase } from './helpers.mjs';

// Business release 2, PR R2-C1 Task 31: a business proposes a share; the staff member decides.

const ADA_USER = DEMO_PROFILES[0].userId;
const TOBI_USER = DEMO_PROFILES[1].userId;
const DAY_MS = 86_400_000;
const sealing = mailSealing(Buffer.alloc(32, 7));
const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  return true;
};

async function setup(database, { locations = [{ slug: 'vi' }] } = {}) {
  await database.fresh();
  const business = await seedBusiness(database, { locations });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI,
  });
  return { ...business, memberId };
}

const inForceAt = async (database, memberId, days) =>
  (
    await database.pool.query(
      `SELECT tipme_share_agreement_at($1, now() + make_interval(days => $2::int)) AS id`,
      [memberId, days],
    )
  ).rows[0].id;

const row = (rows, memberId) => rows.find((r) => r.memberId === memberId);

test('propose 10% then accept: in force from the start date, at least 14 days on', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 1000,
    },
  );
  assert.equal(proposed.state, 'pending');
  assert.equal(proposed.businessPercent, 10);
  assert.equal(proposed.proposedBy, 'business');
  assert.equal(proposed.startsOn, lagosDateOf(shareStartsAt(new Date())));

  // The database stamped the proposal with its own clock, and the start honours the notice.
  const [stored] = (
    await database.pool.query(
      `SELECT proposed_at, effective_from, accepted_at FROM share_agreements WHERE id = $1`,
      [proposed.agreementId],
    )
  ).rows;
  assert.ok(stored.effective_from - stored.proposed_at >= 14 * DAY_MS);
  assert.equal(stored.accepted_at, null);

  const mine = await myShares(database.db, TOBI_USER);
  assert.deepEqual(
    mine.map(({ state, youKeepPercent, proposedBy }) => ({
      state,
      youKeepPercent,
      proposedBy,
    })),
    [{ state: 'proposed', youKeepPercent: 90, proposedBy: 'business' }],
  );

  const accepted = await acceptShare(
    database.db,
    TOBI_USER,
    proposed.agreementId,
  );
  assert.equal(accepted.state, 'scheduled');
  assert.equal(accepted.youKeepPercent, 90);
  // Nothing applies before the start date; it applies from then.
  assert.equal(await inForceAt(database, memberId, 0), null);
  assert.equal(await inForceAt(database, memberId, 13), null);
  assert.equal(await inForceAt(database, memberId, 16), proposed.agreementId);

  const business = row(
    await listBusinessShares(database.db, ADA_USER, businessId),
    memberId,
  );
  assert.equal(business.state, 'in_force');
  assert.equal(business.businessPercent, 10);
  assert.equal(business.startsOn, proposed.startsOn);
});

test('the split is one of the options, capped at 50%', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  for (const bps of [6000, 4000, 1500, -1000, 10000])
    await assert.rejects(
      proposeShare(database.db, sealing, ADA_USER, businessId, {
        memberId,
        businessBps: bps,
      }),
      code('INVALID_INPUT'),
    );
  const fifty = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 5000,
  });
  assert.equal(fifty.businessPercent, 50);
  // 100/0 when there is no share yet changes nothing, so it is not a proposal.
  await withdrawShare(database.db, ADA_USER, businessId, fifty.agreementId);
  await assert.rejects(
    proposeShare(database.db, sealing, ADA_USER, businessId, {
      memberId,
      businessBps: 0,
    }),
    code('SHARE_NOT_ALLOWED'),
  );
});

test('a proposal reaches the member by email when they have a confirmed address, with no amounts', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  await database.pool.query(
    `UPDATE users SET email = 'tobi@example.com', email_verified_at = now() WHERE id = $1`,
    [TOBI_USER],
  );
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 2000,
    },
  );
  const mail = (
    await database.pool.query(
      `SELECT type, user_id, dedupe_key FROM mail_messages WHERE type = 'share_proposed'`,
    )
  ).rows;
  assert.deepEqual(mail, [
    {
      type: 'share_proposed',
      user_id: TOBI_USER,
      dedupe_key: `share_proposed.${proposed.agreementId}`,
    },
  ]);
});

test('one open proposal at a time, and a second change in the same month is refused', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const first = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 1000,
  });
  await assert.rejects(
    proposeShare(database.db, sealing, ADA_USER, businessId, {
      memberId,
      businessBps: 2000,
    }),
    code('SHARE_NOT_ALLOWED'),
  );
  await acceptShare(database.db, TOBI_USER, first.agreementId);
  // The accepted one takes effect this coming month: another change can't take effect then too.
  await assert.rejects(
    proposeShare(database.db, sealing, ADA_USER, businessId, {
      memberId,
      businessBps: 2000,
    }),
    code('SHARE_CHANGE_TOO_SOON'),
  );
});

test('a change is accepted in one transaction: the old agreement names its successor', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  // In force since well before this month, so a change this month is allowed.
  const { agreementId: old } = await seedAgreement(database, {
    memberId,
    businessBps: 1000,
    startedDaysAgo: 70,
  });
  const change = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 3000,
    },
  );
  await acceptShare(database.db, TOBI_USER, change.agreementId);
  const rows = (
    await database.pool.query(
      `SELECT id, superseded_by, accepted_at IS NOT NULL AS accepted FROM share_agreements
        WHERE member_id = $1 ORDER BY effective_from`,
      [memberId],
    )
  ).rows;
  assert.deepEqual(rows, [
    { id: old, superseded_by: change.agreementId, accepted: true },
    { id: change.agreementId, superseded_by: null, accepted: true },
  ]);
  // The old split stays in force through the notice; the new one from its start.
  assert.equal(await inForceAt(database, memberId, 0), old);
  assert.equal(await inForceAt(database, memberId, 16), change.agreementId);
  const mine = await myShares(database.db, TOBI_USER);
  assert.deepEqual(
    mine.map(({ state, youKeepPercent }) => ({ state, youKeepPercent })),
    [
      { state: 'in_force', youKeepPercent: 90 },
      { state: 'scheduled', youKeepPercent: 70 },
    ],
  );
});

test('a declined proposal reads no_change to the business, and nothing says declined', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 1000,
    },
  );
  await declineShare(database.db, TOBI_USER, proposed.agreementId);
  const rows = await listBusinessShares(database.db, ADA_USER, businessId);
  assert.deepEqual(row(rows, memberId), {
    memberId,
    shownName: 'Tobi',
    state: 'no_change',
  });
  assert.doesNotMatch(JSON.stringify(rows), /declin/i);
  // Withdrawing it afterwards answers exactly as for any proposal that can't be withdrawn.
  await assert.rejects(
    withdrawShare(database.db, ADA_USER, businessId, proposed.agreementId),
    code('SHARE_NOT_OPEN'),
  );
  await assert.rejects(
    withdrawShare(database.db, ADA_USER, businessId, randomUUID()),
    code('SHARE_NOT_OPEN'),
  );
  // Answered once: it can't be accepted after a decline.
  await assert.rejects(
    acceptShare(database.db, TOBI_USER, proposed.agreementId),
    code('SHARE_NOT_OPEN'),
  );
  assert.deepEqual(await myShares(database.db, TOBI_USER), []);
});

test('a proposal not answered by its start date lapses as no_change, and a new one can be made', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  // Proposed 15 days ago, starting yesterday, never answered.
  const { agreementId } = await seedAgreement(database, {
    memberId,
    accepted: false,
    startedDaysAgo: 1,
  });
  assert.equal(
    row(await listBusinessShares(database.db, ADA_USER, businessId), memberId)
      .state,
    'no_change',
  );
  assert.deepEqual(await myShares(database.db, TOBI_USER), []);
  await assert.rejects(
    acceptShare(database.db, TOBI_USER, agreementId),
    code('SHARE_NOT_OPEN'),
  );
  const next = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 2000,
  });
  assert.equal(next.state, 'pending');
});

test('suggesting another split declines the proposal and asks the business, who accepts it', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 3000,
    },
  );
  await assert.rejects(
    counterShare(database.db, TOBI_USER, proposed.agreementId, {
      businessBps: 3000,
    }),
    code('SHARE_NOT_ALLOWED'),
  );
  const counter = await counterShare(
    database.db,
    TOBI_USER,
    proposed.agreementId,
    {
      businessBps: 1000,
    },
  );
  assert.equal(counter.state, 'proposed');
  assert.equal(counter.proposedBy, 'member');
  assert.equal(counter.youKeepPercent, 90);
  // The staff member can't accept their own suggestion.
  await assert.rejects(
    acceptShare(database.db, TOBI_USER, counter.agreementId),
    code('SHARE_NOT_OPEN'),
  );
  const pending = row(
    await listBusinessShares(database.db, ADA_USER, businessId),
    memberId,
  );
  assert.deepEqual(
    {
      state: pending.state,
      businessPercent: pending.businessPercent,
      proposedBy: pending.proposedBy,
    },
    { state: 'pending', businessPercent: 10, proposedBy: 'member' },
  );
  // The business can't withdraw the member's suggestion; it answers it.
  await assert.rejects(
    withdrawShare(database.db, ADA_USER, businessId, counter.agreementId),
    code('SHARE_NOT_OPEN'),
  );
  await answerSuggestedShare(
    database.db,
    ADA_USER,
    businessId,
    counter.agreementId,
    'accept',
  );
  const after = row(
    await listBusinessShares(database.db, ADA_USER, businessId),
    memberId,
  );
  assert.equal(after.state, 'in_force');
  assert.equal(after.businessPercent, 10);
  assert.equal(await inForceAt(database, memberId, 16), counter.agreementId);
});

test('two accepts racing leave one agreement accepted', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 1000,
    },
  );
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      acceptShare(database.db, TOBI_USER, proposed.agreementId),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((r) => r.status === 'rejected'))
    assert.equal(r.reason.code, 'SHARE_NOT_OPEN');
  const { n } = (
    await database.pool.query(
      `SELECT count(*)::int AS n FROM share_agreements WHERE member_id = $1 AND accepted_at IS NOT NULL`,
      [memberId],
    )
  ).rows[0];
  assert.equal(n, 1);
});

test('an accept racing a counter: exactly one wins', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const proposed = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 2000,
    },
  );
  const results = await Promise.allSettled([
    acceptShare(database.db, TOBI_USER, proposed.agreementId),
    counterShare(database.db, TOBI_USER, proposed.agreementId, {
      businessBps: 1000,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('a location manager proposes only at their own location', async (t) => {
  const database = await useDatabase(t);
  const { businessId, locations, memberId } = await setup(database, {
    locations: [{ slug: 'vi' }, { slug: 'lekki' }],
  });
  const managerUser = randomUUID();
  await database.pool.query(
    `INSERT INTO users (id, phone_e164) VALUES ($1, '+2348000000077')`,
    [managerUser],
  );
  await seedManager(database, {
    businessId,
    userId: managerUser,
    locationId: locations[1].id,
  });
  await assert.rejects(
    proposeShare(database.db, sealing, managerUser, businessId, {
      memberId,
      businessBps: 1000,
    }),
    code('NOT_A_MANAGER'),
  );
  // They don't see that member's row either.
  assert.equal(
    row(
      await listBusinessShares(database.db, managerUser, businessId),
      memberId,
    ),
    undefined,
  );
  // At their own location they may.
  const { memberId: local } = await seedMember(database, {
    locationId: locations[1].id,
    profileId: DEMO_PROFILES[0].id,
    shownName: 'Ada',
  });
  const ok = await proposeShare(database.db, sealing, managerUser, businessId, {
    memberId: local,
    businessBps: 1000,
  });
  assert.equal(ok.state, 'pending');
  // Not a manager here at all: an unknown business.
  await assert.rejects(
    listBusinessShares(database.db, TOBI_USER, businessId),
    code('NOT_A_MANAGER'),
  );
  // Someone else can't answer Ada's proposal for her.
  await assert.rejects(
    acceptShare(database.db, TOBI_USER, ok.agreementId),
    code('SHARE_NOT_OPEN'),
  );
});

test('a business that is not verified cannot propose', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { businessId, locations } = await seedBusiness(database, {
    status: 'pending',
  });
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI,
  });
  await assert.rejects(
    proposeShare(database.db, sealing, ADA_USER, businessId, {
      memberId,
      businessBps: 1000,
    }),
    code('BUSINESS_NOT_VERIFIED'),
  );
});

test('leaving ends the agreement at once, and rejoining starts at 100/0', async (t) => {
  const database = await useDatabase(t);
  const { businessId, locations, memberId } = await setup(database);
  const { agreementId } = await seedAgreement(database, {
    memberId,
    startedDaysAgo: 40,
  });
  const open = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 2000,
  });
  assert.equal(await inForceAt(database, memberId, 0), agreementId);
  await leaveMember(database, memberId);
  await database.db.transaction((tx) => endShareAgreements(tx, memberId));
  assert.equal(await inForceAt(database, memberId, 0), null);
  const [proposal] = (
    await database.pool.query(
      `SELECT withdrawn_at FROM share_agreements WHERE id = $1`,
      [open.agreementId],
    )
  ).rows;
  assert.ok(proposal.withdrawn_at, 'the open proposal is closed too');
  // Ending twice is harmless.
  await database.db.transaction((tx) => endShareAgreements(tx, memberId));
  const { memberId: again } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI,
  });
  assert.equal(await inForceAt(database, again, 0), null);
  assert.equal(
    row(await listBusinessShares(database.db, ADA_USER, businessId), again)
      .state,
    'no_change',
  );
  assert.deepEqual(await myShares(database.db, TOBI_USER), []);
});

test('the report opens an issue the business never sees', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  await reportBusiness(database.db, TOBI_USER, memberId, {
    reason: 'pressure',
    body: 'They said I would lose shifts.',
  });
  await reportBusiness(database.db, TOBI_USER, memberId, { reason: 'other' });
  const reports = (
    await database.pool.query(
      `SELECT reason, business_id FROM share_reports ORDER BY created_at`,
    )
  ).rows;
  assert.deepEqual(reports, [
    { reason: 'pressure', business_id: businessId },
    { reason: 'other', business_id: businessId },
  ]);
  const issues = (
    await database.pool.query(
      `SELECT kind, severity, subject, summary FROM issues WHERE kind = 'share_report'`,
    )
  ).rows;
  // One issue a day per person, carrying ids and fixed words only: never what they wrote.
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'account');
  assert.equal(issues[0].subject.businessId, businessId);
  assert.doesNotMatch(issues[0].summary, /lose shifts/);
  // Nothing the business reads mentions it.
  assert.doesNotMatch(
    JSON.stringify(await listBusinessShares(database.db, ADA_USER, businessId)),
    /report|pressure/i,
  );
  // Only for the person's own open membership.
  await assert.rejects(
    reportBusiness(database.db, ADA_USER, memberId, { reason: 'other' }),
    code('NO_MEMBERSHIP'),
  );
});
