import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PROFILES, setAccountEmail } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const reason = 'staging test account moving to email sign-in';

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

test('sets a verified email on a phone-only account', async (t) => {
  const { db, rows } = await fresh(t);
  assert.equal(
    await setAccountEmail(db, {
      handle: 'ada',
      email: 'Ada@Example.com',
      reason,
    }),
    'set',
  );
  const [user] = await rows(
    'SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1',
    [ADA.userId],
  );
  assert.deepEqual(user, { email: 'ada@example.com', verified: true });
});

test('refuses an email verified on another account, and an unknown handle', async (t) => {
  const { db } = await fresh(t);
  await setAccountEmail(db, { handle: 'ada', email: 'a@example.com', reason });
  assert.equal(
    await setAccountEmail(db, {
      handle: 'tobi',
      email: 'A@example.com',
      reason,
    }),
    'taken',
  );
  assert.equal(
    await setAccountEmail(db, {
      handle: 'nobody_here',
      email: 'b@example.com',
      reason,
    }),
    'not_found',
  );
  void TOBI;
});

test('is audited with the reason', async (t) => {
  const { db, rows } = await fresh(t);
  await setAccountEmail(db, { handle: 'ada', email: 'a@example.com', reason });
  const [audit] = await rows(
    `SELECT reason, subject_id FROM audit_events WHERE action = 'account.email_set_by_script'`,
  );
  assert.deepEqual(audit, { reason, subject_id: ADA.userId });
});
