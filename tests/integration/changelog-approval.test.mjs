import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 4.2: editors ask with changelog.edit, publishers decide with
// changelog.publish, and an editor can never run it alone.
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Checked the wording with the team today';
const SHA = 'c'.repeat(40);
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
});
after(async () => {
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

beforeEach(async () => {
  for (const table of [
    'ops_sessions',
    'staff_totp',
    'staff_permission_overrides',
    'staff',
    'approval_requests',
    'outbox_events',
    'changelog_entries',
  ])
    await q(`DELETE FROM ${table}`);
});

const people = new Map();
let seq = 0;

async function person({ roleId = 'owner', email } = {}) {
  seq += 1;
  const address = email ?? `cl${seq}.${randomUUID().slice(0, 6)}@example.com`;
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [address],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId });
  return id;
}

async function roleWith(permissions) {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
}

const editor = async (email) =>
  person({ roleId: await roleWith(['changelog.edit']), email });

async function entry(values = {}) {
  const row = {
    pr_number: 400,
    merge_sha: SHA,
    merged_at: '2026-11-06T10:00:00Z',
    pr_title: 'feat: pins',
    staff_text: 'feat: pins — Adds pins.',
    user_text: 'You can pin a supporter note.',
    audience: 'everyone',
    ...values,
  };
  const columns = Object.keys(row);
  await q(
    `INSERT INTO changelog_entries (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return row.pr_number;
}

const ask = (actorId, number = 400, revision = 1) =>
  ops.askToPublishChangelogEntry(database.db, {
    actorId,
    grantId: people.get(actorId).grantId,
    number,
    revision,
    reason: REASON,
    services: services(),
  });
const codeOf = (id) =>
  totpAt(people.get(id).secret, BigInt(Math.floor(Date.now() / 30_000)));
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: codeOf(actorId),
    key,
    services: services(),
  });
const published = async (number = 400) =>
  (
    await q(
      `SELECT published_text, published_revision, approved_by FROM changelog_entries WHERE pr_number = $1`,
      [number],
    )
  )[0];

test('an editor without changelog.publish asks; the request waits for a publisher and shows its full text', async () => {
  const publisher = await person();
  const asker = await editor();
  await entry({ audience: 'pro' });
  const outcome = await ask(asker);
  assert.equal(outcome.state, 'pending');
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    outcome.requestId,
  ]);
  assert.equal(row.action, 'changelog.publish');
  assert.equal(row.permission, 'changelog.publish');
  assert.equal(row.requested_by, asker);
  assert.deepEqual(row.payload, { number: 400, revision: 1 });
  assert.equal(
    row.summary,
    'Show users this What’s new entry (#400, Pro): “You can pin a supporter note.”',
  );
  assert.equal((await published()).published_revision, null);
  // The publisher sees it in Approvals and may decide it; the asker sees their own, and can't.
  const forPublisher = await ops.listApprovals(database.db, {
    actorId: publisher,
  });
  assert.equal(forPublisher[0].id, outcome.requestId);
  assert.equal(forPublisher[0].canDecide, true);
  const forAsker = await ops.listApprovals(database.db, { actorId: asker });
  assert.equal(forAsker[0].mine, true);
  assert.equal(forAsker[0].canDecide, false);
  // The waiting request is on the entry for the admin screens.
  const read = await ops.readChangelogEntry(database.db, 400);
  assert.equal(read.waitingRequestId, outcome.requestId);
  // The publisher is mailed; nothing ran alone.
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.approval_pending'`,
      )
    ).length,
    1,
  );
});

test('a publisher approving it publishes exactly the asked revision', async () => {
  const publisher = await person();
  const asker = await editor();
  await entry();
  const { requestId } = await ask(asker);
  const outcome = await approve(requestId, publisher);
  assert.equal(outcome.status, 'approved', JSON.stringify(outcome));
  const row = await published();
  assert.equal(row.published_text, 'You can pin a supporter note.');
  assert.equal(row.published_revision, 1);
  assert.equal(row.approved_by, publisher);
  const [audit] = await q(
    `SELECT * FROM audit_events WHERE action = 'changelog.approved' AND staff_user_id = $1`,
    [publisher],
  );
  assert.equal(audit.staff_user_id, publisher);
  assert.ok(audit.reason.includes(`"askedBy":"${asker}"`));
  assert.equal(
    (await ops.readChangelogEntry(database.db, 400)).waitingRequestId,
    null,
  );
});

test('an edit after asking makes the request stale at approval, and nothing is published', async () => {
  const publisher = await person();
  const asker = await editor();
  await entry();
  const { requestId } = await ask(asker);
  await ops.editChangelogEntry(database.db, {
    staffUserId: asker,
    number: 400,
    patch: { userText: 'You can pin two notes.', revision: 1 },
  });
  const outcome = await approve(requestId, publisher);
  assert.equal(outcome.status, 'stale');
  assert.equal((await published()).published_revision, null);
  // A withdrawal does the same.
  await ops.editChangelogEntry(database.db, {
    staffUserId: asker,
    number: 400,
    patch: { staffText: 'Staff words only.', revision: 2 },
  });
  const second = await ask(asker, 400, 2);
  await ops.withdrawChangelogEntry(database.db, {
    staffUserId: asker,
    number: 400,
    reason: 'Not ready for users yet',
  });
  // Another publisher: a code is used once, and the first one is spent.
  const another = await person();
  assert.equal((await approve(second.requestId, another)).status, 'stale');
  assert.equal((await published()).published_revision, null);
});

test('a direct approval while a request waits makes the request stale', async () => {
  const publisher = await person();
  const asker = await editor();
  await entry();
  const { requestId } = await ask(asker);
  await ops.approveChangelogEntry(database.db, {
    number: 400,
    revision: 1,
    approverId: publisher,
    reason: REASON,
  });
  assert.equal((await approve(requestId, publisher)).status, 'stale');
  // The log is append-only and keeps earlier tests' rows: look at this publisher's.
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'changelog.approved' AND staff_user_id = $1`,
        [publisher],
      )
    ).length,
    1,
  );
});

test('with no publisher able to enter a code, an editor is refused APPROVAL_NO_APPROVER and nothing runs alone', async () => {
  const asker = await editor();
  await entry();
  await assert.rejects(ask(asker), { code: 'APPROVAL_NO_APPROVER' });
  // A publisher without a confirmed authenticator doesn't count either.
  const publisher = await person();
  await q(`UPDATE staff_totp SET confirmed_at = NULL WHERE user_id = $1`, [
    publisher,
  ]);
  await assert.rejects(ask(asker), { code: 'APPROVAL_NO_APPROVER' });
  assert.equal((await published()).published_revision, null);
  assert.equal((await q(`SELECT 1 FROM approval_requests`)).length, 0);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'serious_action.ran_alone' AND staff_user_id = $1`,
        [asker],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    0,
  );
});

test('the requester cannot approve their own request, by id or by shared mailbox', async () => {
  // Someone holding both may ask; with another publisher, it waits for them.
  const both = await person({ email: 'jane.doe+edit@gmail.com' });
  const twin = await person({ email: 'janedoe@googlemail.com' });
  const other = await person();
  await entry();
  const { requestId } = await ask(both);
  await assert.rejects(approve(requestId, both), {
    code: 'APPROVAL_OWN_REQUEST',
  });
  await assert.rejects(approve(requestId, twin), {
    code: 'APPROVAL_OWN_REQUEST',
  });
  assert.equal((await approve(requestId, other)).status, 'approved');
});

test('someone with neither permission cannot ask, and an editor cannot approve', async () => {
  const publisher = await person();
  const outsider = await person({ roleId: await roleWith(['issues.view']) });
  const asker = await editor();
  const otherEditor = await editor();
  await entry();
  await assert.rejects(ask(outsider), { code: 'PERMISSION_NOT_HELD' });
  const { requestId } = await ask(asker);
  await assert.rejects(approve(requestId, otherEditor), {
    code: 'PERMISSION_NOT_HELD',
  });
  assert.equal((await approve(requestId, publisher)).status, 'approved');
});

test('an editor who loses changelog.edit while it waits ends the request at approval', async () => {
  const publisher = await person();
  const asker = await editor();
  await entry();
  const { requestId } = await ask(asker);
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
     VALUES ($1, 'changelog.edit', 'remove', $2)`,
    [asker, publisher],
  );
  const outcome = await approve(requestId, publisher);
  assert.deepEqual(outcome, { status: 'stale', why: 'requester_lost_access' });
  assert.equal((await published()).published_revision, null);
});

test('a text naming the payment provider cannot be asked for', async () => {
  await person();
  const asker = await editor();
  await entry({ user_text: 'Payouts via Bachs are faster' });
  await assert.rejects(ask(asker), (error) => {
    assert.equal(error.code, 'CHANGELOG_TEXT_NOT_ALLOWED');
    assert.equal(error.detail, 'provider_name');
    return true;
  });
  await entry({ pr_number: 401, user_text: null, audience: 'staff' });
  await assert.rejects(ask(asker, 401), { code: 'INVALID_INPUT' });
  await assert.rejects(ask(asker, 999), { code: 'CHANGELOG_NOT_FOUND' });
  await assert.rejects(ask(asker, 400, 2), {
    code: 'CHANGELOG_EDITED_ELSEWHERE',
  });
});
