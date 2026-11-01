import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { OPS_PERMISSIONS } from '../../packages/contracts/dist/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  holdWithdrawals,
  listIssues,
  openIssue,
  seedDemoProfiles,
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

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => (await response.json()).data;

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
}

/** A tip to Tobi with a message and a name, finished with the given mock checkout outcome. */
async function tipTobi(outcome) {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'tobi',
        amountMinor: '200000',
        currency: 'NGN',
      }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        quoteId: quote.data.quoteId,
        message: 'Secret thanks plugh',
        payerDisplayLabel: 'Hidden Supportername',
      }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  return intent.data.tipId;
}

/** The open mismatch issue for a tip, once the worker has turned the alert into one. */
const mismatchIssueFor = (tipId) =>
  waitFor(async () =>
    (
      await listIssues(database.db, { kind: 'payment_mismatch', limit: 50 })
    ).find((issue) => issue.subject.tipId === tipId),
  );

test('a provider amount mismatch becomes one issue through the outbox and worker', async () => {
  const tipId = await tipTobi('wrong-amount');
  const issue = await mismatchIssueFor(tipId);
  assert.equal(issue.severity, 'money');
  assert.match(issue.summary, /@tobi/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const all = await listIssues(database.db, {
    kind: 'payment_mismatch',
    limit: 50,
  });
  assert.equal(all.filter((i) => i.subject.tipId === tipId).length, 1);
});

test('the evidence shows history, provider events and the page, but no private words or numbers', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348038880001');
  const tipId = await tipTobi('wrong-amount');
  const issue = await mismatchIssueFor(tipId);

  const list = await json(
    await call('GET', '/v1/ops/issues?status=open', owner.cookie),
  );
  assert.ok(list.some((i) => i.id === issue.id));

  const response = await call(
    'GET',
    `/v1/ops/issues/${issue.id}`,
    owner.cookie,
  );
  assert.equal(response.status, 200);
  const evidence = await json(response);
  assert.equal(evidence.issue.id, issue.id);
  assert.equal(evidence.tipProof.tip.id, tipId);
  assert.ok(evidence.tipProof.history.length >= 2);
  assert.ok(
    evidence.providerEvents.some((e) => e.processingOutcome === 'mismatch'),
  );
  assert.ok(evidence.attempts.length >= 1);
  for (const attempt of evidence.attempts)
    assert.ok(
      attempt.referenceTail === null || attempt.referenceTail.length <= 6,
    );
  assert.equal(evidence.page.handle, 'tobi');
  assert.equal(evidence.private.message, true);
  assert.equal(evidence.private.supporterLabel, true);
  assert.match(evidence.traceId ?? '', /^[0-9a-f]{32}$/);
  assert.match(evidence.traceUrl, /\/trace\/[0-9a-f]{32}$/);
  const text = JSON.stringify(evidence);
  assert.equal(text.includes('plugh'), false, 'message hidden');
  assert.equal(text.includes('Supportername'), false, 'supporter name hidden');
  assert.equal(text.includes('mock_pay_'), false, 'full references hidden');

  const audit = await json(await call('GET', '/v1/ops/audit', owner.cookie));
  assert.ok(
    audit.some((e) => e.action === 'issue.viewed' && e.subjectId === issue.id),
  );
});

test('private details are revealed only with a written reason, and the reveal is audited', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348038880002');
  const tipId = await tipTobi('wrong-amount');
  const issue = await mismatchIssueFor(tipId);
  const path = `/v1/ops/issues/${issue.id}/reveal`;
  assert.equal((await call('POST', path, owner.cookie, {})).status, 400);
  assert.equal(
    (await call('POST', path, owner.cookie, { reason: 'short' })).status,
    400,
  );
  const reason = 'Supporter emailed support about this exact tip';
  const revealed = await call('POST', path, owner.cookie, { reason });
  assert.equal(revealed.status, 200);
  const data = await json(revealed);
  assert.equal(data.message, 'Secret thanks plugh');
  assert.equal(data.supporterLabel, 'Hidden Supportername');
  const audit = await json(await call('GET', '/v1/ops/audit', owner.cookie));
  const row = audit.find(
    (e) => e.action === 'private.revealed' && e.subjectId === issue.id,
  );
  assert.equal(row.reason, reason);
  assert.equal(row.permission, 'private.view');
});

test('staff without private.view get 403 on reveal; non-staff get 404 on issues (Review Focus 3)', async () => {
  const viewer = await opsSignIn(stack.api, database.db, '+2348038880003');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('issues_viewer', 'Issues viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('issues_viewer', 'issues.view') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'issues_viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348038880003')`,
  );
  const tipId = await tipTobi('wrong-amount');
  const issue = await mismatchIssueFor(tipId);
  assert.equal(
    (await call('GET', `/v1/ops/issues/${issue.id}`, viewer.cookie)).status,
    200,
  );
  const reveal = await call(
    'POST',
    `/v1/ops/issues/${issue.id}/reveal`,
    viewer.cookie,
    {
      reason: 'Trying to read the private message',
    },
  );
  assert.equal(reveal.status, 403);

  const outsider = await signIn(stack.api, '+2348038880004');
  for (const path of ['/v1/ops/issues', `/v1/ops/issues/${issue.id}`])
    assert.equal((await call('GET', path, outsider.cookie)).status, 404, path);
  assert.equal(
    (
      await call('POST', `/v1/ops/issues/${issue.id}/reveal`, outsider.cookie, {
        reason: 'Trying to read the private message',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        'GET',
        '/v1/ops/issues/00000000-0000-7000-8000-000000000000',
        viewer.cookie,
      )
    ).status,
    404,
  );
});

const moneyIssue = async (profileId, kind = 'payment_reversed') =>
  (
    await openIssue(database.db, {
      dedupeKey: `test.${randomUUID()}`,
      kind,
      subject: { profileId },
      now: new Date(),
    })
  ).id;
const placeHold = async (profileId, issueId) =>
  database.db.transaction((tx) =>
    holdWithdrawals(tx, { profileId, reason: 'reversal', issueId }),
  );
const activeHolds = async (profileId) =>
  (
    await database.pool.query(
      'SELECT 1 FROM withdrawal_holds WHERE profile_id = $1 AND released_at IS NULL',
      [profileId],
    )
  ).rows.length;
const profileIdOf = async (handle) =>
  (
    await database.pool.query('SELECT id FROM profiles WHERE handle = $1', [
      handle,
    ])
  ).rows[0].id;
const REASON = 'The provider settled this in its dashboard.';

test('staff must pick an outcome to resolve a money issue, and resolving releases the hold', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348039990021');
  const profileId = await profileIdOf('ada');
  const issueId = await moneyIssue(profileId);
  await placeHold(profileId, issueId);
  const path = `/v1/ops/issues/${issueId}/resolve`;

  const missing = await call('POST', path, owner.cookie, { reason: REASON });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error.code, 'ISSUE_OUTCOME_REQUIRED');
  assert.equal(
    (
      await call('POST', path, owner.cookie, {
        reason: REASON,
        outcome: 'forgiven',
      })
    ).status,
    400,
  );
  assert.equal(await activeHolds(profileId), 1);

  const balanceRows = async () =>
    (await database.pool.query('SELECT count(*)::int AS n FROM ledger_entries'))
      .rows[0].n;
  const before = await balanceRows();
  assert.equal(
    (
      await call('POST', path, owner.cookie, {
        reason: REASON,
        outcome: 'written_off',
      })
    ).status,
    200,
  );
  assert.equal(await activeHolds(profileId), 0);
  assert.equal(await balanceRows(), before);
  const stored = (
    await database.pool.query(
      'SELECT resolution_outcome FROM issues WHERE id = $1',
      [issueId],
    )
  ).rows[0];
  assert.equal(stored.resolution_outcome, 'written_off');
  const shown = await json(
    await call('GET', `/v1/ops/issues/${issueId}`, owner.cookie),
  );
  assert.equal(shown.issue.resolutionOutcome, 'written_off');
});

test('the hold stays while another money issue for the recipient is open', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348039990022');
  const profileId = await profileIdOf('ada');
  const first = await moneyIssue(profileId);
  const second = await moneyIssue(profileId, 'provider_in_debt');
  await placeHold(profileId, first);
  const resolve = (id) =>
    call('POST', `/v1/ops/issues/${id}/resolve`, owner.cookie, {
      reason: REASON,
      outcome: 'resolved_by_provider',
    });
  assert.equal((await resolve(first)).status, 200);
  assert.equal(await activeHolds(profileId), 1);
  assert.equal((await resolve(second)).status, 200);
  assert.equal(await activeHolds(profileId), 0);
  const released = (
    await database.pool.query(
      'SELECT released_by FROM withdrawal_holds WHERE issue_id = $1',
      [first],
    )
  ).rows[0];
  assert.ok(released.released_by);
});

test('the withdrawal tools need payouts.resolve, on the owner role only, and read before acting', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348039990023');
  const profileId = await profileIdOf('ada');
  const issueId = await moneyIssue(profileId);
  const path = `/v1/ops/issues/${issueId}/payout-read`;
  // Not a withdrawal issue: nothing to read.
  assert.equal((await call('POST', path, owner.cookie, {})).status, 404);
  // Owner always holds every permission, so the test person is on a role holding everything else:
  // a 403 can then only come from payouts.resolve itself.
  const other = await opsSignIn(stack.api, database.db, '+2348039990099');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('no_payouts', 'No payouts') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT 'no_payouts', p FROM unnest($1::text[]) AS p ON CONFLICT DO NOTHING`,
    [OPS_PERMISSIONS.filter((p) => p !== 'payouts.resolve')],
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'no_payouts' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348039990099')`,
  );
  assert.equal((await call('POST', path, other.cookie, {})).status, 403);
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('no_payouts', 'payouts.resolve')`,
  );
  assert.equal((await call('POST', path, other.cookie, {})).status, 404);
  await database.pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'no_payouts' AND permission = 'payouts.resolve'`,
  );
  const { rows } = await database.pool.query(
    `SELECT role_id FROM role_permissions WHERE permission = 'payouts.resolve'`,
  );
  assert.deepEqual(
    rows.map((r) => r.role_id),
    ['owner'],
  );
  for (const [action, body] of [
    ['payout-apply', { reason: REASON }],
    ['payout-mark-failed', { reason: REASON }],
    ['payout-mark-failed', { dashboardVerified: true }],
  ])
    assert.equal(
      (
        await call(
          'POST',
          `/v1/ops/issues/${issueId}/${action}`,
          owner.cookie,
          body,
        )
      ).status,
      400,
      action,
    );
});

test('a held withdrawal is read at the pretend provider, resumed, and only then started', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348039990024');
  const profileId = await profileIdOf('ada');
  const payoutId = randomUUID();
  await database.pool.query(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint, provider)
     VALUES ($1, $2, 'NGN', 100, 'REQUESTED', $3, 'f', 'mock')`,
    [payoutId, profileId, randomUUID()],
  );
  const issue = await openIssue(database.db, {
    dedupeKey: `payout_held.${payoutId}`,
    kind: 'payout_held',
    subject: { payoutId },
    now: new Date(),
  });
  const base = `/v1/ops/issues/${issue.id}`;
  const view = await json(
    await call('POST', `${base}/payout-read`, owner.cookie, {}),
  );
  assert.equal(view.read.state, 'absent');
  assert.equal(view.offers.resume, true);
  assert.equal(view.offers.markFailed, false);
  const resumed = await json(
    await call('POST', `${base}/payout-resume`, owner.cookie, {
      reason: REASON,
    }),
  );
  assert.equal(resumed.outcome, 'resumed');
  await waitFor(
    async () =>
      (
        await database.pool.query(
          'SELECT provider_reference FROM payouts WHERE id = $1',
          [payoutId],
        )
      ).rows[0].provider_reference,
    20_000,
  );
  const again = await json(
    await call('POST', `${base}/payout-resume`, owner.cookie, {
      reason: REASON,
    }),
  );
  assert.equal(again.outcome, 'not_offered');
});
