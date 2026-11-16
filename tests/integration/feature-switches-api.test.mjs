import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { FEATURE_SWITCH_CATALOGUE } from '../../packages/contracts/dist/index.js';
import {
  MAIL_SEAL_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Feature switches in admin (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md): staff set
// them at /v1/ops/switches; a money switch waits for a second person; each still gates its feature.

const REASON = 'Agreed with the owner on the call today';
let database;
let stack;
let phones = 0;
// A fresh Nigerian mobile number per call: +234 and ten digits.
const phone = () =>
  `+23481${String(process.pid % 10_000).padStart(4, '0')}${String(++phones).padStart(4, '0')}`;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '1000',
      // Seeds on this first start: business on, everything else at its default.
      BUSINESS_ENABLED: 'true',
    },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const opsCall = (session, method, path, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(session.cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('the first start wrote every switch, the old variable included, and logged it', async () => {
  const rows = await q(
    `SELECT key, enabled, source FROM feature_switches ORDER BY key`,
  );
  assert.equal(rows.length, 17);
  assert.deepEqual(
    rows.find((r) => r.key === 'business'),
    {
      key: 'business',
      enabled: true,
      source: 'env',
    },
  );
  assert.equal(rows.find((r) => r.key === 'pro_billing').source, 'default');
  assert.ok(
    stack.logs.some(
      (l) => l.event === 'feature_switch.seeded' && l.key === 'business',
    ),
  );
});

test('a second start with the variable changed keeps the stored value and names the variable', async () => {
  const second = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, BUSINESS_ENABLED: 'false' },
  });
  try {
    const release = await (await fetch(`${second.api}/health/release`)).json();
    assert.equal(release.data.business, true);
    const ignored = second.logs.filter(
      (l) => l.event === 'feature_switch.env_ignored',
    );
    assert.deepEqual(
      ignored.map((l) => l.setting),
      ['BUSINESS_ENABLED'],
    );
    assert.ok(!JSON.stringify(ignored).includes('false'), 'never the value');
  } finally {
    await second.stop();
  }
});

test('an owner reads every switch with its state, default and history', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const response = await opsCall(session, 'GET', '/v1/ops/switches');
  assert.equal(response.status, 200);
  const { switches } = (await response.json()).data;
  // 12 from #216, business_pro, business_signup, business_owners, campaign_pages (train 2), and tip_refunds (#221).
  assert.equal(switches.length, 17);
  const studio = switches.find((s) => s.key === 'page_studio');
  assert.equal(studio.on, false);
  assert.equal(studio.envName, 'PAGE_STUDIO_ENABLED');
  assert.equal(studio.history.length, 1);
  assert.equal(studio.history[0].source, 'default');
});

test('staff without switches.manage get 403', async () => {
  const number = phone();
  const session = await opsSignIn(stack.api, database.db, number);
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  await q(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT $1, permission FROM role_permissions WHERE role_id = 'owner' AND permission <> 'switches.manage'`,
    [role],
  );
  await q(
    `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
    [role, number],
  );
  assert.equal((await opsCall(session, 'GET', '/v1/ops/switches')).status, 403);
  assert.equal(
    (
      await opsCall(session, 'POST', '/v1/ops/switches/page_studio', {
        on: true,
        reason: REASON,
      })
    ).status,
    403,
  );
});

test('a non-money switch changes at once with a reason, is audited, and gates its feature', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  assert.equal(
    (
      await opsCall(session, 'POST', '/v1/ops/switches/adult_platform_links', {
        on: false,
        reason: 'x',
      })
    ).status,
    400,
    'a reason of at least 10 characters',
  );
  const off = await opsCall(
    session,
    'POST',
    '/v1/ops/switches/adult_platform_links',
    {
      on: false,
      reason: REASON,
    },
  );
  assert.equal(off.status, 200);
  const body = (await off.json()).data;
  assert.equal(
    body.switches.find((s) => s.key === 'adult_platform_links').on,
    false,
  );
  // The same process forgot its cache: the change shows at once.
  assert.equal(await ops.featureOn(database.db, 'adult_platform_links'), false);
  const [audit] = await q(
    `SELECT permission, subject_id, reason FROM audit_events WHERE action = 'feature_switch.set' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(audit.permission, 'switches.manage');
  assert.equal(audit.subject_id, 'adult_platform_links');
  assert.ok(audit.reason.startsWith(REASON));
  // No approval request for a non-money switch.
  assert.equal(
    (
      await q(
        `SELECT 1 FROM approval_requests WHERE action = 'feature_switch.set'`,
      )
    ).length,
    0,
  );
  // Setting it to what it already is is refused.
  const again = await opsCall(
    session,
    'POST',
    '/v1/ops/switches/adult_platform_links',
    {
      on: false,
      reason: REASON,
    },
  );
  assert.equal(again.status, 400);
  await setSwitch(database.pool, 'adult_platform_links', true);
});

// 16 Nov 2026: team_tips (no routes) and business_owners (read by no screen) have nothing built
// behind them. They stay registered, marked, and can't be turned on; off always works.
test('a switch with nothing built behind it is marked, and turning it on is refused before any approval', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const listed = (
    await (await opsCall(session, 'GET', '/v1/ops/switches')).json()
  ).data.switches;
  assert.deepEqual(
    listed
      .filter((s) => s.notBuilt)
      .map((s) => s.key)
      .sort(),
    ['business_owners', 'team_tips'],
  );
  assert.ok(listed.every((s) => typeof s.notBuilt === 'boolean'));
  const before = await q(
    `SELECT count(*)::int AS n FROM approval_requests WHERE action = 'feature_switch.set'`,
  );
  for (const key of ['team_tips', 'business_owners']) {
    const refused = await opsCall(session, 'POST', `/v1/ops/switches/${key}`, {
      on: true,
      reason: REASON,
    });
    assert.equal(refused.status, 409, key);
    assert.equal((await refused.json()).error.code, 'SWITCH_NOT_BUILT', key);
    assert.equal(await ops.featureOn(database.db, key), false, key);
  }
  // Nothing was asked of a second person for the money one.
  assert.deepEqual(
    await q(
      `SELECT count(*)::int AS n FROM approval_requests WHERE action = 'feature_switch.set'`,
    ),
    before,
  );
  // One already on (an old variable, a row from before) can still be turned off.
  await setSwitch(database.pool, 'business_owners', true);
  const off = await opsCall(
    session,
    'POST',
    '/v1/ops/switches/business_owners',
    { on: false, reason: REASON },
  );
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal(await ops.featureOn(database.db, 'business_owners'), false);
});

test('an approval asked before a switch was marked not built can’t turn it on either', async () => {
  await assert.rejects(
    database.db.transaction((tx) =>
      ops.setFeatureSwitch(tx, {
        key: 'team_tips',
        on: true,
        staffUserId: randomUUID(),
        approvedBy: randomUUID(),
        reason: REASON,
        now: new Date(),
      }),
    ),
    (error) => error.code === 'SWITCH_NOT_BUILT',
  );
  assert.equal(await ops.featureOn(database.db, 'team_tips'), false);
});

// 16 Nov 2026: the admin page view lists a page's Pro payments whatever the pro_refunds switch,
// with the month each bought; only asking for a refund needs the switch on.
test('a page’s Pro payments are listed with their month while refunds are off; asking is refused', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const ada = ops.DEMO_PROFILES[0];
  const price = String((await ops.currentProPrice(database.db)).amountMinor);
  const reference = randomUUID();
  const bought = await ops.buyProByCheckout(database.db, {
    profileId: ada.id,
    expectedAmountMinor: BigInt(price),
    idempotencyKey: randomUUID(),
    provider: {
      async initializePlatformCheckout() {
        return {
          providerReference: `platform:cs_${reference}`,
          checkoutUrl: 'https://checkout.example/session/x',
          expiresAt: new Date(Date.now() + 30 * 60_000),
        };
      },
      async verifyTransaction() {
        throw new Error('not here');
      },
    },
    providerName: 'mock',
    successUrl: `${WEB}/dashboard/settings`,
    cancelUrl: `${WEB}/dashboard/settings`,
    now: new Date(),
  });
  await ops.confirmProCheckout(database.db, {
    purchaseId: bought.purchaseId,
    verified: {
      status: 'succeeded',
      amountMinor: BigInt(price),
      currency: 'NGN',
      feeMinor: 5000n,
      method: 'NGN_CARD',
      chargeReference: `ch_${reference.slice(0, 8)}`,
    },
    now: new Date(),
    sealing: ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64')),
  });
  await setSwitch(database.pool, 'pro_refunds', false);
  const listed = await opsCall(
    session,
    'GET',
    `/v1/ops/pro/pages/${ada.id}/payments`,
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const { refundsOn, payments } = (await listed.json()).data;
  assert.equal(refundsOn, false);
  const row = payments.find((p) => p.purchaseId === bought.purchaseId);
  assert.ok(row, 'the paid month is listed');
  assert.equal(row.amountMinor, price);
  assert.equal(row.paidBy, 'card');
  assert.equal(row.refundable, true, 'refundable by the rules, switch aside');
  assert.ok(row.period?.startsAt && row.period?.endsAt);
  assert.ok(Date.parse(row.period.endsAt) > Date.parse(row.period.startsAt));
  const asked = await opsCall(
    session,
    'POST',
    `/v1/ops/pro/purchases/${bought.purchaseId}/refund`,
    { reason: REASON },
  );
  assert.equal(asked.status, 404);
  assert.equal((await asked.json()).error.code, 'PRO_REFUNDS_OFF');
  assert.equal(
    (
      await q(`SELECT 1 FROM pro_refunds WHERE purchase_id = $1`, [
        bought.purchaseId,
      ])
    ).length,
    0,
  );
});

test('an unknown switch is 404', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const response = await opsCall(session, 'POST', '/v1/ops/switches/nope', {
    on: true,
    reason: REASON,
  });
  assert.equal(response.status, 404);
});

test('a money switch waits for a second person; approved, it changes and Pro billing opens', async () => {
  const asker = await opsSignIn(stack.api, database.db, phone());
  const approver = await opsSignIn(stack.api, database.db, phone());
  const price = async () =>
    (await (await fetch(`${stack.api}/v1/pro/price`)).json()).data.billingOn;
  assert.equal(await price(), false);
  const asked = await opsCall(asker, 'POST', '/v1/ops/switches/pro_billing', {
    on: true,
    reason: REASON,
  });
  assert.equal(asked.status, 202);
  const { requestId } = (await asked.json()).data;
  assert.equal(await price(), false, 'nothing changes while it waits');
  const listed = (
    await (await opsCall(asker, 'GET', '/v1/ops/switches')).json()
  ).data;
  assert.equal(
    listed.switches.find((s) => s.key === 'pro_billing').waitingRequestId,
    requestId,
  );
  const [request] = await q(
    `SELECT permission, summary FROM approval_requests WHERE id = $1`,
    [requestId],
  );
  assert.equal(request.permission, 'switches.manage');
  assert.equal(request.summary, 'Turn Pro billing on');
  const approved = await opsCall(
    approver,
    'POST',
    `/v1/ops/approvals/${requestId}/approve`,
    {
      code: await approver.nextCode(),
    },
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal(await price(), true, 'the approving copy forgot its cache');
  const [change] = await q(
    `SELECT changed_by, approved_by FROM feature_switch_changes WHERE key = 'pro_billing' AND source = 'staff'`,
  );
  assert.ok(change.changed_by && change.approved_by);
  assert.notEqual(change.changed_by, change.approved_by);
  await setSwitch(database.pool, 'pro_billing', false);
});

test('every moved switch still gates its feature', async (t) => {
  const { cookie } = await signIn(stack.api, ops.DEMO_PROFILES[0].phone);
  const get = async (path, headers = {}) => {
    const response = await fetch(`${stack.api}${path}`, {
      headers: { cookie, ...headers },
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  const ownerSession = await opsSignIn(stack.api, database.db, phone());
  const ada = (await q(`SELECT id FROM profiles WHERE handle_lower = 'ada'`))[0]
    .id;
  const { TeamTipsEnabledGuard } =
    await import('../../apps/api/dist/business/release2-flags.guard.js');
  const teamGuard = stack.app.get(TeamTipsEnabledGuard, { strict: false });
  const gates = {
    business: async () => (await get('/v1/me/business-roles')).status !== 404,
    business_shares: async () =>
      (await get('/v1/me/work/shares')).status !== 404,
    team_tips: () =>
      teamGuard.canActivate().then(
        () => true,
        () => false,
      ),
    pro_billing: async () => (await get('/v1/pro/price')).body.data.billingOn,
    pro_pay_from_balance: async () => {
      const mine = await get('/v1/me/pro');
      return mine.status === 200 && mine.body.data.methods.includes('balance');
    },
    pro_auto_renew: async () => {
      const mine = await get('/v1/me/pro');
      return mine.status === 200 && mine.body.data.autoRenew.available;
    },
    // The history is readable either way (16 Nov 2026); the switch says whether refunds are on.
    pro_refunds: async () => {
      const response = await fetch(
        `${stack.api}/v1/ops/pro/pages/${ada}/payments`,
        { headers: browserHeaders(ownerSession.cookie) },
      );
      assert.equal(response.status, 200);
      return (await response.json()).data.refundsOn;
    },
    analytics: async () => (await get('/health/release')).body.data.analytics,
    supporter_recognition: async () => {
      await q(`UPDATE profiles SET plan = 'pro' WHERE id = $1`, [ada]);
      return (await get('/v1/profiles/ada')).body.data.recognition === true;
    },
    adult_platform_links: async () =>
      (await get('/v1/me/profile')).body.data.adultLinks,
  };
  for (const [key, open] of Object.entries(gates))
    await t.test(key, async () => {
      // The release 2 switches sit on top of the business one.
      await setSwitch(database.pool, 'business', true);
      await setSwitch(database.pool, key, false);
      assert.equal(await open(), false, `${key} off`);
      await setSwitch(database.pool, key, true);
      assert.equal(await open(), true, `${key} on`);
    });
  // Back to the seeded values for anything after.
  for (const key of Object.keys(gates))
    await setSwitch(
      database.pool,
      key,
      key === 'business' || FEATURE_SWITCH_CATALOGUE[key].default,
    );
});

// Display settings (owner, 14 Nov 2026, #216): the web reads them on /health/release.
test('an owner sets the pilot notice and the launch time; /health/release serves them', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const release = async () =>
    (await (await fetch(`${stack.api}/health/release`)).json()).data.display;
  assert.deepEqual(await release(), {
    pilotNotice: { set: false, on: false },
    launch: { set: false, at: null },
  });
  const listed = (
    await (await opsCall(session, 'GET', '/v1/ops/switches')).json()
  ).data;
  assert.deepEqual(
    listed.display.map((d) => [d.key, d.set, d.envName]),
    [
      ['pilot_notice', false, 'PILOT_NOTICE'],
      ['production_launch_at', false, 'PRODUCTION_LAUNCH_AT'],
      // The announcements daily limit (15 Nov 2026) is kept here too; it replaced no variable.
      ['announcement_daily_limit', false, null],
    ],
  );
  const set = (key, value) =>
    opsCall(session, 'POST', `/v1/ops/switches/display/${key}`, {
      value,
      reason: REASON,
    });
  const on = await set('pilot_notice', 'on');
  assert.equal(on.status, 200);
  assert.equal(
    (await on.json()).data.display.find((d) => d.key === 'pilot_notice').value,
    'on',
  );
  assert.deepEqual((await release()).pilotNotice, { set: true, on: true });
  assert.equal(
    (await set('production_launch_at', '2027-01-01T00:00:00+01:00')).status,
    200,
  );
  assert.deepEqual((await release()).launch, {
    set: true,
    at: '2026-12-31T23:00:00.000Z',
  });
  assert.equal((await set('production_launch_at', null)).status, 200);
  assert.deepEqual((await release()).launch, { set: true, at: null });
  assert.equal((await set('production_launch_at', 'tomorrow')).status, 400);
  assert.equal((await set('pilot_notice', 'on')).status, 400, 'no change');
  assert.equal((await set('nope', 'on')).status, 404);
  const audits = await q(
    `SELECT subject_id FROM audit_events WHERE action = 'display_setting.set' ORDER BY created_at`,
  );
  assert.deepEqual(
    audits.map((a) => a.subject_id),
    ['pilot_notice', 'production_launch_at', 'production_launch_at'],
  );
  await database.pool.query('DELETE FROM display_settings');
});

// The announcements daily limit (owner, 15 Nov 2026): set in Switches like a display setting, a
// whole number from 1 to 100,000; never served on /health/release.
test('an owner sets the announcements daily limit; checked, and not public', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const set = (value) =>
    opsCall(
      session,
      'POST',
      '/v1/ops/switches/display/announcement_daily_limit',
      { value, reason: REASON },
    );
  for (const bad of ['0', '100001', 'many', null])
    assert.equal((await set(bad)).status, 400, String(bad));
  const saved = await set('1200');
  assert.equal(saved.status, 200);
  const limit = (await saved.json()).data.display.find(
    (d) => d.key === 'announcement_daily_limit',
  );
  assert.equal(limit.value, '1200');
  assert.equal(limit.group, 'limits');
  assert.deepEqual(limit.count, { default: 300, min: 1, max: 100_000 });
  const release = (await (await fetch(`${stack.api}/health/release`)).json())
    .data.display;
  assert.deepEqual(Object.keys(release).sort(), ['launch', 'pilotNotice']);
  await database.pool.query('DELETE FROM display_settings');
});
