import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
  withdrawalQuote,
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
  await database.pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission = 'payouts.resolve'`,
  );
  try {
    assert.equal((await freeze()).status, 403);
  } finally {
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission) VALUES ('owner', 'payouts.resolve')`,
    );
  }
});
