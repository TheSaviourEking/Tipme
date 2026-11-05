import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';

// Staff reservations of usernames (docs/superpowers/specs/2026-11-03-username-reservation-design.md).
// The database guard comes first: a release that predates reservations (after a rollback) must not
// hand a reserved name out, so the refusal lives in triggers as well as in the application.

let database;
before(async () => {
  database = await openTestDatabase();
});
beforeEach(async () => {
  await database.reset();
});
after(async () => {
  await database.close();
});

const UNIQUE_VIOLATION = '23505';

async function refusedWith(code, promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const reserve = (key) =>
  database.pool.query(
    `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_at)
     VALUES ($1, $2, 'staff', 'brand name', now()) RETURNING id`,
    [randomUUID(), key],
  );

const insertPage = (handle) =>
  database.pool.query(
    `INSERT INTO profiles (id, handle, handle_lower, display_name)
     VALUES ($1, $2, lower($2), 'Page') RETURNING id`,
    [randomUUID(), handle],
  );

test('the trigger refuses a claim on a reserved name', async () => {
  await reserve('mtn');
  await refusedWith(UNIQUE_VIOLATION, insertPage('mtn'));
  const { rowCount } = await database.pool.query(
    `SELECT 1 FROM profiles WHERE handle_lower = 'mtn'`,
  );
  assert.equal(rowCount, 0);
});

test('the trigger refuses a rename onto a reserved name', async () => {
  const { rows } = await insertPage('kemi');
  await reserve('mtn');
  await refusedWith(
    UNIQUE_VIOLATION,
    database.pool.query(
      `UPDATE profiles SET handle = 'mtn', handle_lower = 'mtn' WHERE id = $1`,
      [rows[0].id],
    ),
  );
  // A change that does not touch the handle is left alone.
  await database.pool.query(
    `UPDATE profiles SET display_name = 'Kemi' WHERE id = $1`,
    [rows[0].id],
  );
});

test('the trigger refuses an alias insert on a reserved name', async () => {
  const { rows } = await insertPage('kemi');
  await reserve('mtn');
  await refusedWith(
    UNIQUE_VIOLATION,
    database.pool.query(
      `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('mtn', $1)`,
      [rows[0].id],
    ),
  );
});

test('a reservation is refused while a page or an old username holds the name', async () => {
  const { rows } = await insertPage('kemi');
  await refusedWith(UNIQUE_VIOLATION, reserve('kemi'));
  await database.pool.query(
    `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('kemi_old', $1)`,
    [rows[0].id],
  );
  await refusedWith(UNIQUE_VIOLATION, reserve('kemi_old'));
});

test('a released reservation no longer blocks a claim', async () => {
  const { rows: staff } = await database.pool.query(
    `INSERT INTO users (id) VALUES ($1) RETURNING id`,
    [randomUUID()],
  );
  await database.pool.query(
    `INSERT INTO handle_reservations
       (id, handle_lower, source, reason, reserved_at, released_at, released_by, release_reason)
     VALUES ($1, 'mtn', 'staff', 'brand name', now(), now(), $2, 'no longer needed')`,
    [randomUUID(), staff[0].id],
  );
  await insertPage('mtn');
});

test('a release must say who and why', async () => {
  await refusedWith(
    '23514',
    database.pool.query(
      `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_at, released_at)
       VALUES ($1, 'mtn', 'staff', 'brand name', now(), now())`,
      [randomUUID()],
    ),
  );
});

test('two active reservations of one key cannot exist', async () => {
  await reserve('mtn');
  await refusedWith(UNIQUE_VIOLATION, reserve('mtn'));
});
