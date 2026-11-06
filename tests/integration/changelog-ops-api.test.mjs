import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { totpAt } from '../../packages/domain/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 4.3: the changelog in admin, through the API.
const REASON = 'Checked the wording with the team today';
const SHA = 'e'.repeat(40);

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let owner;
let editor;
let ownerId;
let secondId;
let editorId;
let editorRole;
let publisherRole;

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const idOf = async (phone) =>
  (await q(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]))[0].id;
const roleWith = async (permissions) => {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
};

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
    },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348037780001');
  // A second owner, for the tests that want a second person.
  await opsSignIn(stack.api, database.db, '+2348037780002');
  editor = await opsSignIn(stack.api, database.db, '+2348037780003');
  ownerId = await idOf('+2348037780001');
  secondId = await idOf('+2348037780002');
  editorId = await idOf('+2348037780003');
  await q(`UPDATE users SET email = 'owner.person@example.com' WHERE id = $1`, [
    ownerId,
  ]);
  editorRole = await roleWith(['changelog.edit']);
  publisherRole = await roleWith(['changelog.publish']);
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

beforeEach(async () => {
  await q(`UPDATE staff SET role_id = 'owner', revoked_at = NULL`);
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    editorId,
    editorRole,
  ]);
  // The second owner is only there when a test wants a second person.
  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [secondId]);
  await q(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  await q(`UPDATE staff_totp SET last_step = NULL`);
  await q(`DELETE FROM changelog_entries`);
  await q(
    `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text, audience)
     VALUES (500, $1, '2026-11-05T10:00:00Z', 'feat: pins', 'feat: pins — Adds pins.', 'You can pin a supporter note.', 'everyone'),
            (501, $1, '2026-11-06T10:00:00Z', 'fix(ci): faster', 'fix(ci): faster — Caches.', NULL, 'staff')`,
    [SHA],
  );
});

const call = (method, path, who, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? { cookie: who.cookie } : browserHeaders(who.cookie),
    ...(body === undefined || method === 'GET'
      ? {}
      : { body: JSON.stringify(body) }),
  });
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const staleCode = (userId) =>
  q(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '1 hour' WHERE user_id = $1`,
    [userId],
  );
const entryRow = async (number = 500) =>
  (
    await q(`SELECT * FROM changelog_entries WHERE pr_number = $1`, [number])
  )[0];
const codeOf = (who) =>
  totpAt(who.secret, BigInt(Math.floor(Date.now() / 30_000)));

test('the list and an entry: editors and publishers read them, nobody else does, and no code is needed', async () => {
  for (const [who, role] of [
    [editor, editorRole],
    [editor, publisherRole],
  ]) {
    await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
      editorId,
      role,
    ]);
    await staleCode(editorId);
    const list = await json(await call('GET', '/v1/ops/changelog', who));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(
      list.body.data.rows.map((row) => [row.number, row.state]),
      [
        [501, 'recorded'],
        [500, 'draft'],
      ],
    );
    assert.equal(list.body.data.nextBefore, null);
    const drafts = await json(
      await call('GET', '/v1/ops/changelog?view=drafts', who),
    );
    assert.deepEqual(
      drafts.body.data.rows.map((row) => row.number),
      [500],
    );
    const one = await json(await call('GET', '/v1/ops/changelog/500', who));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.userText, 'You can pin a supporter note.');
    assert.deepEqual(one.body.data.problems, []);
  }
  const outsider = await roleWith(['issues.view']);
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    editorId,
    outsider,
  ]);
  for (const path of ['/v1/ops/changelog', '/v1/ops/changelog/500'])
    assert.equal((await call('GET', path, editor)).status, 403);
  assert.equal(
    (await call('GET', '/v1/ops/changelog?view=nope', owner)).status,
    400,
  );
});

test('a number that is not a positive whole number, or no entry, is 404', async () => {
  for (const number of ['abc', '-1', '0', '1e3', '5O0', '500.0', '99999999999'])
    assert.equal(
      (await call('GET', `/v1/ops/changelog/${number}`, owner)).status,
      404,
      number,
    );
  const missing = await json(await call('GET', '/v1/ops/changelog/999', owner));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'CHANGELOG_NOT_FOUND');
  assert.equal(
    (
      await call('PUT', '/v1/ops/changelog/-5', owner, {
        userText: 'x',
        revision: 1,
      })
    ).status,
    404,
  );
});

test('an editor saves without a code; an old revision is 409', async () => {
  await staleCode(editorId);
  const saved = await json(
    await call('PUT', '/v1/ops/changelog/500', editor, {
      userText: 'You can pin notes.',
      audience: 'pro',
      revision: 1,
    }),
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.revision, 2);
  assert.equal(saved.body.data.audience, 'pro');
  const again = await json(
    await call('PUT', '/v1/ops/changelog/500', editor, {
      userText: 'Something else.',
      revision: 1,
    }),
  );
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'CHANGELOG_EDITED_ELSEWHERE');
  assert.equal(
    (
      await call('PUT', '/v1/ops/changelog/500', editor, {
        userText: 'x',
        revision: 2,
        extra: true,
      })
    ).status,
    400,
  );
});

test('a publisher approves with a fresh code; the entry shows who, masked', async () => {
  await staleCode(ownerId);
  const stale = await json(
    await call('POST', '/v1/ops/changelog/500/approve', owner, {
      revision: 1,
      reason: REASON,
    }),
  );
  assert.equal(stale.status, 403);
  assert.equal(stale.body.error.code, 'FRESH_CODE_REQUIRED');
  assert.equal((await entryRow()).published_revision, null);
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  const approved = await json(
    await call('POST', '/v1/ops/changelog/500/approve', owner, {
      revision: 1,
      reason: REASON,
    }),
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.state, 'approved');
  assert.equal(
    approved.body.data.publishedText,
    'You can pin a supporter note.',
  );
  assert.equal(approved.body.data.approvedBy, 'o•••@example.com');
  const read = await json(await call('GET', '/v1/ops/changelog/500', editor));
  assert.equal(read.body.data.approvedBy, 'o•••@example.com');
  assert.ok(!JSON.stringify(read.body).includes('owner.person'));
  // An editor can't approve directly.
  await call('PUT', '/v1/ops/changelog/500', editor, {
    userText: 'You can pin notes.',
    revision: 1,
  });
  assert.equal(
    (
      await call('POST', '/v1/ops/changelog/500/approve', editor, {
        revision: 2,
        reason: REASON,
      })
    ).status,
    403,
  );
});

test('a text naming the payment partner is refused 422 next to the user text, with the reason', async () => {
  await call('PUT', '/v1/ops/changelog/500', owner, {
    userText: 'Payouts via Bachs are faster, and TipMe is licensed',
    revision: 1,
  });
  const refused = await json(
    await call('POST', '/v1/ops/changelog/500/approve', owner, {
      revision: 2,
      reason: REASON,
    }),
  );
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'CHANGELOG_TEXT_NOT_ALLOWED');
  assert.deepEqual(refused.body.error.fields, ['userText']);
  assert.equal(refused.body.error.reason, 'provider_name,regulatory_claim');
  const read = await json(await call('GET', '/v1/ops/changelog/500', owner));
  assert.deepEqual(read.body.data.problems, [
    'provider_name',
    'regulatory_claim',
  ]);
});

test('an editor asks: 202 with the request, it waits in Approvals for a publisher, and approving there publishes', async () => {
  await q(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [secondId]);
  const asked = await json(
    await call('POST', '/v1/ops/changelog/500/ask', editor, {
      revision: 1,
      reason: REASON,
    }),
  );
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const { requestId } = asked.body.data;
  assert.ok(requestId);
  assert.equal((await entryRow()).published_revision, null);
  const list = await json(await call('GET', '/v1/ops/changelog', owner));
  assert.equal(
    list.body.data.rows.find((row) => row.number === 500).waitingRequestId,
    requestId,
  );
  const approvals = await json(await call('GET', '/v1/ops/approvals', owner));
  const request = approvals.body.data.find((row) => row.id === requestId);
  assert.ok(request, 'in Approvals');
  assert.equal(request.canDecide, true);
  assert.match(request.summary, /#500, everyone/);
  const decided = await json(
    await call('POST', `/v1/ops/approvals/${requestId}/approve`, owner, {
      code: codeOf(owner),
    }),
  );
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const row = await entryRow();
  assert.equal(row.published_revision, 1);
  assert.equal(row.approved_by, ownerId);
});

test('asking needs changelog.edit and a fresh code; with no publisher it is 409', async () => {
  await staleCode(editorId);
  const stale = await json(
    await call('POST', '/v1/ops/changelog/500/ask', editor, {
      revision: 1,
      reason: REASON,
    }),
  );
  assert.equal(stale.status, 403);
  assert.equal(stale.body.error.code, 'FRESH_CODE_REQUIRED');
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  // A publisher-only role can't ask: they approve.
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    editorId,
    publisherRole,
  ]);
  assert.equal(
    (
      await call('POST', '/v1/ops/changelog/500/ask', editor, {
        revision: 1,
        reason: REASON,
      })
    ).status,
    403,
  );
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    editorId,
    editorRole,
  ]);
  await q(`UPDATE staff SET revoked_at = now() WHERE role_id = 'owner'`);
  const nobody = await json(
    await call('POST', '/v1/ops/changelog/500/ask', editor, {
      revision: 1,
      reason: REASON,
    }),
  );
  assert.equal(nobody.status, 409);
  assert.equal(nobody.body.error.code, 'APPROVAL_NO_APPROVER');
  assert.equal(
    nobody.body.error.message,
    'Nobody who can approve this is set up yet.',
  );
  assert.equal((await entryRow()).published_revision, null);
});

test('withdrawing needs a reason, takes no code, and keeps the entry in All as withdrawn', async () => {
  await call('POST', '/v1/ops/changelog/500/approve', owner, {
    revision: 1,
    reason: REASON,
  });
  await staleCode(editorId);
  const noReason = await call(
    'POST',
    '/v1/ops/changelog/500/withdraw',
    editor,
    {},
  );
  assert.equal(noReason.status, 400);
  const short = await call('POST', '/v1/ops/changelog/500/withdraw', editor, {
    reason: 'no',
  });
  assert.equal(short.status, 400);
  const withdrawn = await json(
    await call('POST', '/v1/ops/changelog/500/withdraw', editor, {
      reason: 'The change was rolled back today',
    }),
  );
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.data.state, 'withdrawn');
  const all = await json(await call('GET', '/v1/ops/changelog', editor));
  assert.equal(
    all.body.data.rows.find((row) => row.number === 500).state,
    'withdrawn',
  );
  const users = await json(
    await call('GET', '/v1/ops/changelog?view=users', editor),
  );
  assert.deepEqual(users.body.data.rows, []);
});

test('signed out, or signed in without an admin grant, every route is hidden', async () => {
  for (const [method, path] of [
    ['GET', '/v1/ops/changelog'],
    ['GET', '/v1/ops/changelog/500'],
    ['PUT', '/v1/ops/changelog/500'],
    ['POST', '/v1/ops/changelog/500/ask'],
    ['POST', '/v1/ops/changelog/500/approve'],
    ['POST', '/v1/ops/changelog/500/withdraw'],
  ]) {
    const response = await call(
      method,
      path,
      { cookie: owner.sessionCookie },
      {
        revision: 1,
        reason: REASON,
      },
    );
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});
