import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  notesVisibleToBusiness,
  reportNoteAsMember,
  seedDemoProfiles,
  writeBusinessNote,
} from '../../packages/database/dist/index.js';
import {
  payAtBusiness,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// TipMe for businesses, PR B5 Task 17: TipMe staff read a reported note only through a reasoned,
// audited reveal, then restore or remove it.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
const REASON = 'Reviewing the reported note today.';
let database;
let stack;
let owner;
let business;
let memberId;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348038880011');
  business = await seedBusiness(database, { owner: TOBI.userId });
  ({ memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  }));
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function reportedNote(body) {
  const { tipId } = await payAtBusiness(stack.api, { handle: 'ada', memberId });
  for (let i = 0; i < 100; i++) {
    const { rows } = await database.pool.query(
      'SELECT status FROM tips WHERE id = $1',
      [tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeBusinessNote(database.db, tipId, { tags: ['fast'], body });
  await reportNoteAsMember(database.db, {
    userId: ADA.userId,
    tipId,
    reason: 'abusive',
  });
  return tipId;
}

test('staff read the text only through a reasoned reveal; review restores or removes it, audited, and resolves the issue', async () => {
  const kept = await reportedNote('Quick and kind.');
  const gone = await reportedNote('Not kind at all.');
  const reveal = (tipId, reason) =>
    call('POST', `/v1/ops/business-notes/${tipId}/reveal`, owner.cookie, {
      reason,
    });
  assert.equal((await reveal(gone, 'short')).status, 400);
  const revealed = await reveal(gone, REASON);
  assert.equal(revealed.status, 200);
  assert.equal(revealed.headers.get('cache-control'), 'private, no-store');
  const data = (await revealed.json()).data;
  assert.equal(data.body, 'Not kind at all.');
  assert.equal(data.shownName, 'Tobi');
  assert.equal(data.report.reason, 'abusive');
  const audit = await database.pool.query(
    `SELECT staff_user_id IS NOT NULL AS by_staff, reason FROM audit_events
      WHERE action = 'business_note.reveal' AND subject_id = $1`,
    [gone],
  );
  assert.deepEqual(audit.rows, [{ by_staff: true, reason: REASON }]);

  const review = (tipId, outcome) =>
    call('POST', `/v1/ops/business-notes/${tipId}/review`, owner.cookie, {
      outcome,
      reason: REASON,
    });
  assert.equal((await review(kept, 'restored')).status, 200);
  assert.equal((await review(gone, 'removed')).status, 200);
  const twice = await review(gone, 'restored');
  assert.equal(twice.status, 409);
  assert.equal((await twice.json()).error.code, 'ISSUE_RESOLVED');
  const shown = await notesVisibleToBusiness(database.db, business.businessId);
  assert.equal(shown.has(kept), true);
  assert.equal(shown.has(gone), false);
  const issues = await database.pool.query(
    `SELECT status FROM issues WHERE kind = 'business_note_reported' AND subject->>'tipId' = ANY($1)`,
    [[kept, gone]],
  );
  assert.deepEqual(
    issues.rows.map((row) => row.status),
    ['resolved', 'resolved'],
  );
});

test('an unreported note cannot be revealed (404); staff without the permission get 403; others 404', async () => {
  const { tipId } = await payAtBusiness(stack.api, { handle: 'ada', memberId });
  for (let i = 0; i < 100; i++) {
    const { rows } = await database.pool.query(
      'SELECT status FROM tips WHERE id = $1',
      [tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeBusinessNote(database.db, tipId, { tags: ['fast'] });
  const unreported = await call(
    'POST',
    `/v1/ops/business-notes/${tipId}/reveal`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(unreported.status, 404);

  const reported = await reportedNote('Fine words.');
  const viewer = await opsSignIn(stack.api, database.db, '+2348038880012');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('issues_viewer', 'Issues viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('issues_viewer', 'issues.view') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'issues_viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348038880012')`,
  );
  for (const [path, body] of [
    [`/v1/ops/business-notes/${reported}/reveal`, { reason: REASON }],
    [
      `/v1/ops/business-notes/${reported}/review`,
      { outcome: 'removed', reason: REASON },
    ],
  ])
    assert.equal(
      (await call('POST', path, viewer.cookie, body)).status,
      403,
      path,
    );
  const outsider = await signIn(stack.api, '+2348038880013');
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/business-notes/${reported}/reveal`,
        outsider.cookie,
        { reason: REASON },
      )
    ).status,
    404,
  );
  // Nothing was decided.
  const { rows } = await database.pool.query(
    'SELECT outcome FROM business_note_flags WHERE tip_id = $1',
    [reported],
  );
  assert.deepEqual(rows, [{ outcome: null }]);
});
