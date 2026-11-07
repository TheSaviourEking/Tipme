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
  leaveBusiness,
  listBusinessShares,
  mailSealing,
  myShares,
  proposeShare,
  removeMember,
  reportBusiness,
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
  // Accepted, but the business still reads its own proposal as pending until the start date.
  assert.equal(business.state, 'pending');
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
  await database.pool.query(
    `UPDATE share_agreements SET withdrawn_at = now() WHERE id = $1`,
    [fifty.agreementId],
  );
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

test('one proposal at a time, and a second change in the same month is refused', async (t) => {
  const database = await useDatabase(t);
  const { businessId, memberId } = await setup(database);
  const first = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 3000,
  });
  await assert.rejects(
    proposeShare(database.db, sealing, ADA_USER, businessId, {
      memberId,
      businessBps: 2000,
    }),
    code('SHARE_NOT_ALLOWED'),
  );
  // The member suggests 10% and the business accepts it: the business knows this change, which
  // takes effect this coming month, so another change can't take effect then too.
  const counter = await counterShare(
    database.db,
    TOBI_USER,
    first.agreementId,
    {
      businessBps: 1000,
    },
  );
  await answerSuggestedShare(
    database.db,
    ADA_USER,
    businessId,
    counter.agreementId,
    'accept',
  );
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

test('before its start date, an accepted and a declined proposal look the same to the business', async (t) => {
  const database = await useDatabase(t);
  const { businessId, locations, memberId } = await setup(database);
  const { memberId: other } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: DEMO_PROFILES[0].id,
    shownName: 'Ada',
  });
  const toTobi = await proposeShare(
    database.db,
    sealing,
    ADA_USER,
    businessId,
    {
      memberId,
      businessBps: 1000,
    },
  );
  const toAda = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId: other,
    businessBps: 1000,
  });
  await acceptShare(database.db, TOBI_USER, toTobi.agreementId);
  await declineShare(database.db, ADA_USER, toAda.agreementId);
  const rows = await listBusinessShares(database.db, ADA_USER, businessId);
  const shape = (r) => {
    const rest = { ...r };
    delete rest.memberId;
    delete rest.shownName;
    delete rest.agreementId;
    return rest;
  };
  assert.deepEqual(shape(row(rows, memberId)), shape(row(rows, other)));
  assert.deepEqual(shape(row(rows, memberId)), {
    state: 'pending',
    businessPercent: 10,
    startsOn: toTobi.startsOn,
    proposedBy: 'business',
  });
  assert.deepEqual(
    Object.keys(row(rows, memberId)).sort(),
    Object.keys(row(rows, other)).sort(),
  );
  assert.doesNotMatch(JSON.stringify(rows), /declin|accept/i);
  // A new proposal is refused the same way for both while they read pending.
  for (const id of [memberId, other])
    await assert.rejects(
      proposeShare(database.db, sealing, ADA_USER, businessId, {
        memberId: id,
        businessBps: 2000,
      }),
      code('SHARE_NOT_ALLOWED'),
    );
  // Answered once: a declined proposal can't then be accepted.
  await assert.rejects(
    acceptShare(database.db, ADA_USER, toAda.agreementId),
    code('SHARE_NOT_OPEN'),
  );
});

// Proposals whose start date has passed, written as history (the database refuses a backdated
// proposal or acceptance except through the test-only setting).
async function seedAnswered(
  database,
  { memberId, answer, businessBps = 1000, startedDaysAgo = 2 },
) {
  const id = randomUUID();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL tipme.allow_backdate = 'on'`);
    await client.query(
      `INSERT INTO share_agreements (id, member_id, business_bps, proposed_by, proposed_by_user,
         proposed_at, effective_from)
       VALUES ($1, $2, $3, 'business', $4, now() - make_interval(days => $5::int + 14),
         now() - make_interval(days => $5::int))`,
      [id, memberId, businessBps, ADA_USER, startedDaysAgo],
    );
    await client.query(
      `UPDATE share_agreements SET ${answer === 'accepted' ? 'accepted_at' : 'declined_at'} =
         now() - make_interval(days => $2::int + 13) WHERE id = $1`,
      [id, startedDaysAgo],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return id;
}

test('from its start date the business sees the outcome: the split if accepted, no change if declined', async (t) => {
  const database = await useDatabase(t);
  const { businessId, locations, memberId } = await setup(database);
  const { memberId: other } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: DEMO_PROFILES[0].id,
    shownName: 'Ada',
  });
  const accepted = await seedAnswered(database, {
    memberId,
    answer: 'accepted',
  });
  await seedAnswered(database, { memberId: other, answer: 'declined' });
  const rows = await listBusinessShares(database.db, ADA_USER, businessId);
  assert.deepEqual(
    {
      state: row(rows, memberId).state,
      businessPercent: row(rows, memberId).businessPercent,
      agreementId: row(rows, memberId).agreementId,
    },
    { state: 'in_force', businessPercent: 10, agreementId: accepted },
  );
  assert.deepEqual(row(rows, other), {
    memberId: other,
    shownName: 'Ada',
    state: 'no_change',
  });
  assert.doesNotMatch(JSON.stringify(rows), /declin/i);
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
  // Not the business's own proposal: it can't answer it as the member would.
  await assert.rejects(
    answerSuggestedShare(
      database.db,
      ADA_USER,
      businessId,
      proposed.agreementId,
      'accept',
    ),
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

test('a suggestion the business declined leaves no change, and the countered proposal never reappears', async (t) => {
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
  const counter = await counterShare(
    database.db,
    TOBI_USER,
    proposed.agreementId,
    {
      businessBps: 1000,
    },
  );
  await answerSuggestedShare(
    database.db,
    ADA_USER,
    businessId,
    counter.agreementId,
    'decline',
  );
  const after = row(
    await listBusinessShares(database.db, ADA_USER, businessId),
    memberId,
  );
  assert.deepEqual(after, { memberId, shownName: 'Tobi', state: 'no_change' });
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

test('leaving, or being removed by the business, ends the share in the same transaction (M16, merge train 2)', async (t) => {
  const database = await useDatabase(t);
  const { businessId, locations, memberId } = await setup(database, {
    locations: [{ slug: 'vi' }, { slug: 'lekki' }],
  });
  const { memberId: atLekki } = await seedMember(database, {
    locationId: locations[1].id,
    profileId: TOBI,
  });
  const left = await seedAgreement(database, { memberId, startedDaysAgo: 40 });
  const removed = await seedAgreement(database, {
    memberId: atLekki,
    startedDaysAgo: 40,
  });
  const open = await proposeShare(database.db, sealing, ADA_USER, businessId, {
    memberId,
    businessBps: 2000,
  });
  assert.equal(await inForceAt(database, memberId, 0), left.agreementId);
  assert.equal(await inForceAt(database, atLekki, 0), removed.agreementId);

  // B3's own leave: the share and the open proposal end with the membership, nothing else needed.
  await leaveBusiness(database.db, TOBI_USER, memberId);
  assert.equal(await inForceAt(database, memberId, 0), null);
  const [state] = (
    await database.pool.query(
      `SELECT (SELECT ended_at FROM share_agreements WHERE id = $1) AS ended,
              (SELECT withdrawn_at FROM share_agreements WHERE id = $2) AS withdrawn`,
      [left.agreementId, open.agreementId],
    )
  ).rows;
  assert.ok(state.ended, 'the agreement in force ended');
  assert.ok(state.withdrawn, 'the open proposal closed');

  // B3's removal by the business does the same for the other membership.
  await removeMember(database.db, ADA_USER, businessId, atLekki);
  assert.equal(await inForceAt(database, atLekki, 0), null);
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
