import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  mailSealing,
  seedDemoProfiles,
  setPayoutDestination,
  withdrawalQuote,
  withdrawalsFrozen,
} from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const TOBI = DEMO_PROFILES[1].id;
const REASON = 'Owner rang: someone else took over this account.';

let database;
let stack;
let owner;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348031110021');
});
after(async () => {
  await stack.stop();
  await database.close();
});
beforeEach(async () => {
  await database.pool.query('DELETE FROM withdrawal_holds');
  await database.pool.query('DELETE FROM issues');
});

const post = (path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });
const freeze = (cookie = owner.cookie, profileId = TOBI, reason = REASON) =>
  post(`/v1/ops/pages/${profileId}/withdrawal-freeze`, cookie, { reason });
const rows = (sql, params) =>
  database.pool.query(sql, params).then((result) => result.rows);
const auditCount = async (action) =>
  (await rows('SELECT id FROM audit_events WHERE action = $1', [action]))
    .length;
const reader = {
  name: 'mock',
  payoutBalance: async () => ({ availableMinor: 0n }),
  quotePayoutFee: async () => ({ feeMinor: 0n, exact: true }),
};

test('staff freeze a reported takeover: a held reason, a money issue, an audit line with the reason', async () => {
  const frozenBefore = await auditCount('withdrawals.frozen');
  const response = await freeze();
  assert.equal(response.status, 200);
  const { state, issueId } = (await response.json()).data;
  assert.equal(state, 'frozen');
  const [hold] = await rows(
    'SELECT reason, issue_id, released_at FROM withdrawal_holds WHERE profile_id = $1',
    [TOBI],
  );
  assert.equal(hold.reason, 'account_takeover');
  assert.equal(hold.issue_id, issueId);
  assert.equal(hold.released_at, null);
  const [issue] = await rows(
    'SELECT kind, severity, status, subject, summary FROM issues WHERE id = $1',
    [issueId],
  );
  assert.equal(issue.kind, 'account_takeover_reported');
  assert.equal(issue.severity, 'money');
  assert.equal(issue.subject.profileId, TOBI);
  // Staff's words stay in the audit log, never the inbox text.
  assert.ok(!issue.summary.includes(REASON));
  const audit = await rows(
    `SELECT action, permission, subject_id, reason, staff_user_id FROM audit_events
      WHERE action = 'withdrawals.frozen' ORDER BY created_at DESC, id DESC`,
  );
  assert.equal(audit.length, frozenBefore + 1);
  assert.equal(audit[0].permission, 'payouts.resolve');
  assert.equal(audit[0].subject_id, TOBI);
  assert.equal(audit[0].reason, REASON);
  assert.ok(audit[0].staff_user_id);
});

test('the recipient sees only the usual pause: the reason never reaches them', async () => {
  await freeze();
  assert.deepEqual(
    await withdrawalQuote(database.db, { profileId: TOBI, provider: reader }),
    { state: 'paused', reason: 'review' },
  );
});

test('freezing twice keeps one hold and one issue', async () => {
  const frozenBefore = await auditCount('withdrawals.frozen');
  const first = (await (await freeze()).json()).data;
  const second = (await (await freeze()).json()).data;
  assert.deepEqual(second, { state: 'already_frozen', issueId: first.issueId });
  assert.equal((await rows('SELECT id FROM withdrawal_holds')).length, 1);
  assert.equal((await rows('SELECT id FROM issues')).length, 1);
  assert.equal(await auditCount('withdrawals.frozen'), frozenBefore + 1);
});

test('resolving the issue with account_secured releases the freeze, audited; a later report opens a new one', async () => {
  const releasedBefore = await auditCount('withdrawals.released');
  const { issueId } = (await (await freeze()).json()).data;
  const resolved = await post(
    `/v1/ops/issues/${issueId}/resolve`,
    owner.cookie,
    {
      reason: 'Owner has the account back and a new sign-in.',
      outcome: 'account_secured',
      bankAndSignInChecked: true,
    },
  );
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const [hold] = await rows('SELECT released_at FROM withdrawal_holds');
  assert.ok(hold.released_at);
  assert.equal(await auditCount('withdrawals.released'), releasedBefore + 1);
  const again = (await (await freeze()).json()).data;
  assert.equal(again.state, 'frozen');
  assert.notEqual(again.issueId, issueId);
});

test('another money issue closing does not release the freeze', async () => {
  await freeze();
  const [{ id: other }] = await rows(
    `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
     VALUES ($1, $2, 'payout_failed', 'money', $3, 'x', now()) RETURNING id`,
    [randomUUID(), `test.${randomUUID()}`, { profileId: TOBI }],
  );
  const resolved = await post(`/v1/ops/issues/${other}/resolve`, owner.cookie, {
    reason: 'Checked with the provider, all fine here.',
    outcome: 'resolved_by_provider',
  });
  assert.equal(resolved.status, 200);
  const [hold] = await rows('SELECT released_at FROM withdrawal_holds');
  assert.equal(hold.released_at, null);
});

test('it is staff only, needs payouts.resolve, a written reason, and a real page', async () => {
  // Admin routes answer anyone who isn't signed in as staff as if they did not exist.
  assert.equal((await freeze('')).status, 404);
  const person = await signIn(stack.api, '+2348031110022');
  assert.equal((await freeze(person.cookie)).status, 404);
  assert.equal((await freeze(owner.cookie, TOBI, 'short')).status, 400);
  assert.equal((await freeze(owner.cookie, randomUUID())).status, 404);
  assert.equal((await rows('SELECT id FROM withdrawal_holds')).length, 0);

  // A role without payouts.resolve is refused.
  // An owner holds the whole catalogue, whatever is stored: move them to a role without it.
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('no_payouts', 'No payouts') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'no_payouts' WHERE role_id = 'owner'`,
  );
  try {
    assert.equal((await freeze()).status, 403);
  } finally {
    await database.pool.query(
      `UPDATE staff SET role_id = 'owner' WHERE role_id = 'no_payouts'`,
    );
  }
});

const resolve = (issueId, body) =>
  post(`/v1/ops/issues/${issueId}/resolve`, owner.cookie, {
    reason: 'Owner proved who they are, and the account is theirs.',
    ...body,
  });

test('releasing a freeze needs written confirmation that bank and sign-in were checked, and says so in the audit', async () => {
  const { issueId } = (await (await freeze()).json()).data;
  for (const body of [
    { outcome: 'account_secured' },
    { outcome: 'account_secured', bankAndSignInChecked: false },
    { outcome: 'written_off', bankAndSignInChecked: true },
  ]) {
    assert.notEqual((await resolve(issueId, body)).status, 200);
    const [hold] = await rows('SELECT released_at FROM withdrawal_holds');
    assert.equal(hold.released_at, null, JSON.stringify(body));
  }
  const done = await resolve(issueId, {
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
  assert.equal(done.status, 200);
  const [audit] = await rows(
    `SELECT reason FROM audit_events WHERE action = 'issue.resolved' AND subject_id = $1`,
    [issueId],
  );
  assert.match(audit.reason, /^Current bank and sign-in checked\. /);
});

test('account_secured is only for a takeover: other money issues refuse it', async () => {
  const [{ id }] = await rows(
    `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
     VALUES ($1, $2, 'payout_failed', 'money', $3, 'x', now()) RETURNING id`,
    [randomUUID(), `test.${randomUUID()}`, { profileId: TOBI }],
  );
  assert.notEqual(
    (await resolve(id, { outcome: 'account_secured' })).status,
    200,
  );
});

test('while frozen the bank cannot change, under the profile lock; after release it can', async () => {
  const bank = {
    sealing: mailSealing(Buffer.alloc(32, 7)),
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: `pd_${randomUUID().slice(0, 8)}`,
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '6789',
    status: 'usable',
  };
  assert.equal(
    await withdrawalsFrozen(database.db, { profileId: TOBI }),
    false,
  );
  const { issueId } = (await (await freeze()).json()).data;
  assert.equal(await withdrawalsFrozen(database.db, { profileId: TOBI }), true);
  await assert.rejects(setPayoutDestination(database.db, bank), {
    code: 'WITHDRAWALS_PAUSED',
  });
  await resolve(issueId, {
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
  assert.equal(
    await withdrawalsFrozen(database.db, { profileId: TOBI }),
    false,
  );
  await setPayoutDestination(database.db, bank);
});

test('closing the takeover issue while another issue that places a hold is open keeps the hold until that closes too', async () => {
  const { issueId } = (await (await freeze()).json()).data;
  const [{ id: other }] = await rows(
    `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
     VALUES ($1, $2, 'payment_reversed', 'money', $3, 'x', now()) RETURNING id`,
    [randomUUID(), `test.${randomUUID()}`, { profileId: TOBI }],
  );
  await resolve(issueId, {
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
  assert.equal(
    (await rows('SELECT released_at FROM withdrawal_holds'))[0].released_at,
    null,
  );
  await resolve(other, { outcome: 'resolved_by_provider' });
  assert.ok(
    (await rows('SELECT released_at FROM withdrawal_holds'))[0].released_at,
  );
});

test('a failed withdrawal left open does not keep a released takeover on hold', async () => {
  const { issueId } = (await (await freeze()).json()).data;
  await rows(
    `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
     VALUES ($1, $2, 'payout_failed', 'money', $3, 'x', now())`,
    [randomUUID(), `test.${randomUUID()}`, { profileId: TOBI }],
  );
  await resolve(issueId, {
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
  assert.ok(
    (await rows('SELECT released_at FROM withdrawal_holds'))[0].released_at,
  );
});

test('a second report while frozen keeps its written reason in the audit, and the screen can read the freeze', async () => {
  const state = async () =>
    (
      await (
        await fetch(`${stack.api}/v1/ops/pages/${TOBI}/withdrawal-freeze`, {
          headers: { cookie: owner.cookie },
        })
      ).json()
    ).data;
  assert.deepEqual(await state(), { issueId: null });
  const { issueId } = (await (await freeze()).json()).data;
  assert.deepEqual(await state(), { issueId });
  const second = 'A second person rang about the same account.';
  await freeze(owner.cookie, TOBI, second);
  const [audit] = await rows(
    `SELECT reason, subject_id FROM audit_events
      WHERE action = 'withdrawals.freeze_reported_again' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.equal(audit.reason, second);
  assert.equal(audit.subject_id, TOBI);
});

test('a new report after the last closed, with a reversal still holding, opens an issue only it can release', async () => {
  const { issueId: first } = (await (await freeze()).json()).data;
  const [{ id: reversal }] = await rows(
    `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
     VALUES ($1, $2, 'payment_reversed', 'money', $3, 'x', now()) RETURNING id`,
    [randomUUID(), `test.${randomUUID()}`, { profileId: TOBI }],
  );
  await resolve(first, {
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
  const report = (await (await freeze()).json()).data;
  assert.equal(report.state, 'frozen');
  assert.notEqual(report.issueId, first);
  const screen = await fetch(
    `${stack.api}/v1/ops/pages/${TOBI}/withdrawal-freeze`,
    { headers: { cookie: owner.cookie } },
  );
  assert.deepEqual((await screen.json()).data, { issueId: report.issueId });
  await resolve(reversal, { outcome: 'resolved_by_provider' });
  assert.equal(await withdrawalsFrozen(database.db, { profileId: TOBI }), true);
  assert.deepEqual(
    await rows(
      `SELECT id FROM issues WHERE kind = 'account_takeover_reported' AND status = 'open'`,
    ),
    [{ id: report.issueId }],
  );
  assert.equal(
    (
      await resolve(report.issueId, {
        outcome: 'account_secured',
        bankAndSignInChecked: true,
      })
    ).status,
    200,
  );
  assert.equal(
    await withdrawalsFrozen(database.db, { profileId: TOBI }),
    false,
  );
});

test('staff can end all of an account’s sessions, audited; not a staff account, and only with the permission', async () => {
  const person = await signIn(stack.api, '+2348031110023');
  const me = () =>
    fetch(`${stack.api}/v1/me/profile`, { headers: { cookie: person.cookie } });
  assert.notEqual((await me()).status, 401);
  const [{ user_id: userId }] = await rows(
    `SELECT id AS user_id FROM users WHERE phone_e164 = '+2348031110023'`,
  );
  const end = (id = userId, cookie = owner.cookie, reason = REASON) =>
    post(`/v1/ops/accounts/${id}/end-sessions`, cookie, { reason });
  assert.equal((await end(userId, person.cookie)).status, 404);
  assert.equal((await end(userId, owner.cookie, 'short')).status, 400);
  assert.equal((await end(randomUUID())).status, 404);
  const response = await end();
  assert.equal(response.status, 200);
  assert.equal((await me()).status, 401);
  const [audit] = await rows(
    `SELECT reason, permission, subject_id FROM audit_events
      WHERE action = 'account.sessions_ended' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.equal(audit.reason, REASON);
  assert.equal(audit.permission, 'recoveries.manage');
  assert.equal(audit.subject_id, userId);
  const [{ id: staffId }] = await rows(
    `SELECT id FROM users WHERE phone_e164 = '+2348031110021'`,
  );
  assert.equal((await end(staffId)).status, 409);
});
