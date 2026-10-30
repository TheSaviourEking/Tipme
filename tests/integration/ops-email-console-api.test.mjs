import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPS_PERMISSION } from '../../apps/api/dist/ops/ops.guard.js';
import { OpsEmailConsoleController } from '../../apps/api/dist/ops/email-console.controller.js';
import {
  DEMO_PROFILES,
  enqueueMail,
  mailSealing,
  recordMailEvent,
  sealSecret,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const ops = { userId: TOBI.userId };
const tip = {
  firstName: 'Ada',
  netMinor: '180000',
  supporterLabel: 'Tobi',
  pretendPayment: false,
};
let n = 0;

async function setup(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  const mail = async (type, data, userId = null) => {
    const { id } = await enqueueMail(db, sealing, {
      type,
      to: `secret-address-${++n}@example.com`,
      data,
      userId,
      dedupeKey: `${type}.${n}`,
    });
    await recordMailEvent(db, {
      messageId: id,
      kind: 'sent',
      provider: 'ses',
      occurredAt: new Date(),
      type,
      category: type === 'tip_received' ? 'transactional' : 'security',
    });
    return id;
  };
  return {
    ...database,
    mail,
    api: new OpsEmailConsoleController({ db }, sealing),
  };
}

const code = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code ?? error.getStatus?.();
  }
};

test('each route names the permission it needs', () => {
  const expected = {
    summary: 'issues.view',
    series: 'issues.view',
    messages: 'issues.view',
    timeline: 'issues.view',
    content: 'issues.view',
    revealRecipient: 'private.view',
    exportCsv: 'issues.view',
  };
  for (const [method, permission] of Object.entries(expected))
    assert.equal(
      Reflect.getMetadata(
        OPS_PERMISSION,
        OpsEmailConsoleController.prototype[method],
      ),
      permission,
      method,
    );
});

test('summary, series and the message list work for a period', async (t) => {
  const { api, mail } = await setup(t);
  const id = await mail('tip_received', tip, ADA.userId);
  const summary = await api.summary({ period: 'today' });
  assert.equal(summary.data.totals.sent.count, 1);
  assert.equal((await api.series({ period: 'today' })).data.length, 24);
  const list = await api.messages({ period: 'today', account: 'ada' });
  assert.deepEqual(
    list.data.rows.map((r) => r.id),
    [id],
  );
  assert.equal(list.data.rows[0].toHint.includes('secret-address'), false);
  const nobody = await api.messages({
    period: 'today',
    account: 'no_such_one',
  });
  assert.deepEqual(nobody.data.rows, []);
});

test('content is withheld for security mail', async (t) => {
  const { api, mail } = await setup(t);
  const id = await mail('email_verification_link', {
    token: 'sample-token-sample-token-sample-token-0001',
  });
  assert.deepEqual((await api.content(ops, id)).data, { status: 'withheld' });
});

test('content shows the snapshot; an unknown id is 404', async (t) => {
  const { api, mail, db } = await setup(t);
  const id = await mail('tip_received', tip);
  await db.execute(
    `UPDATE mail_messages SET rendered_sealed = '${sealSecret(sealing.key, JSON.stringify({ subject: 'S', html: '<p>H</p>', text: 'T' }))}' WHERE id = '${id}'`,
  );
  assert.equal((await api.content(ops, id)).data.subject, 'S');
  assert.equal(
    await code(api.content(ops, '00000000-0000-7000-8000-000000000000')),
    'NOT_FOUND',
  );
  assert.equal(await code(api.content(ops, 'not-a-uuid')), 'NOT_FOUND');
});

test('revealing a recipient is audited with the reason', async (t) => {
  const { api, mail, pool } = await setup(t);
  const id = await mail('tip_received', tip);
  const result = await api.revealRecipient(ops, id, {
    reason: 'support asked about this email',
  });
  assert.match(result.data.address, /^secret-address-\d+@example\.com$/);
  const { rows } = await pool.query(
    `SELECT reason FROM audit_events WHERE action = 'email.recipient_revealed'`,
  );
  assert.equal(rows[0].reason, 'support asked about this email');
});

test('the export contains no full address and is audited', async (t) => {
  const { api, mail, pool } = await setup(t);
  await mail('tip_received', tip);
  const sent = {};
  const response = {
    setHeader: (k, v) => (sent[k.toLowerCase()] = v),
  };
  const messages = await api.exportCsv(
    ops,
    { period: 'today', kind: 'messages' },
    response,
  );
  assert.ok(!messages.includes('secret-address'));
  assert.match(
    messages,
    /^created_at,type,category,recipient,provider,status,last_event\n/,
  );
  assert.match(messages, /s•••@example\.com/);
  assert.match(sent['content-type'], /text\/csv/);
  const summary = await api.exportCsv(
    ops,
    { period: 'today', kind: 'summary' },
    response,
  );
  assert.match(summary, /^measure,count,previous,change_pct\nsent,1,0,\n/);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.exported'`,
  );
  assert.equal(rows[0].n, 2);
});

test('a CSV cell can never be read as a spreadsheet formula', async (t) => {
  const { api, pool, mail } = await setup(t);
  const id = await mail('tip_received', tip);
  await pool.query(
    `UPDATE mail_messages SET to_hint = '=cmd()' WHERE id = $1`,
    [id],
  );
  const out = await api.exportCsv(
    ops,
    { period: 'today', kind: 'messages' },
    { setHeader() {} },
  );
  assert.ok(!/,=cmd/.test(out));
  assert.match(out, /'=cmd\(\)/);
});

test('period parameters are validated', async () => {
  const { opsMailPeriodQuerySchema } =
    await import('../../packages/contracts/dist/index.js');
  const ok = (q) => opsMailPeriodQuerySchema.safeParse(q).success;
  assert.equal(ok({ period: 'this_week' }), true);
  assert.equal(ok({ period: 'range' }), false);
  assert.equal(
    ok({ period: 'range', from: '2026-10-05', to: '2026-10-01' }),
    false,
  );
  assert.equal(
    ok({ period: 'range', from: '2026-10-01', to: '2026-10-05' }),
    true,
  );
  assert.equal(ok({ period: 'forever' }), false);
});
