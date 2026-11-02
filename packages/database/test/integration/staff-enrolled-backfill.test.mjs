import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { useDatabase } from './helpers.mjs';

// The migration's backfill, run on rows from each kind of history. Nobody with an unclear history
// may come out looking like a mere invitee, who could decline or delete their account.
const DIR = new URL('../../drizzle/', import.meta.url);

async function backfillStatement() {
  const file = (await readdir(DIR)).find((name) =>
    /^\d+_staff_enrolled_at\.sql$/.test(name),
  );
  assert.ok(file, 'the migration exists');
  const parts = (await readFile(new URL(file, DIR), 'utf8')).split(
    '--> statement-breakpoint',
  );
  const update = parts.find((part) => /UPDATE\s+"?staff"?/i.test(part));
  assert.ok(update, 'the migration backfills');
  return update;
}

test('only someone clearly invited and never enrolled stays null', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  await q(
    `INSERT INTO roles (id, name) VALUES ('owner', 'Owner') ON CONFLICT DO NOTHING`,
  );
  const person = async (revoked = false) => {
    const [{ id }] = await q(
      `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
    );
    await q(
      `INSERT INTO staff (user_id, role_id, granted_at, revoked_at)
         VALUES ($1, 'owner', '2026-01-01', $2)`,
      [id, revoked ? '2026-02-01' : null],
    );
    return id;
  };
  const audit = (action, subject, at) =>
    q(
      `INSERT INTO audit_events (id, action, subject_type, subject_id, created_at)
         VALUES (gen_random_uuid(), $1, 'user', $2, $3)`,
      [action, subject, at],
    );

  const confirmed = await person();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'x', '2026-03-01')`,
    [confirmed],
  );
  const onlyAudit = await person(); // Lost their authenticator to a reset or a phone move.
  await audit('ops.authenticator_enrolled', onlyAudit, '2026-03-02');
  await audit('ops.authenticator_enrolled', onlyAudit, '2026-05-02');
  const invited = await person();
  await audit('staff.added', invited, '2026-01-01');
  const invitedThenEnrolled = await person();
  await audit('staff.added', invitedThenEnrolled, '2026-01-01');
  await audit('ops.authenticator_enrolled', invitedThenEnrolled, '2026-03-03');
  const noHistory = await person(); // grant-owner, or anything older than the log.
  const started = await person(); // An unconfirmed authenticator: no invitation on record.
  await q(`INSERT INTO staff_totp (user_id, secret_enc) VALUES ($1, 'x')`, [
    started,
  ]);
  const removedInvitee = await person(true);
  await audit('staff.added', removedInvitee, '2026-01-01');

  await q(await backfillStatement());
  const at = async (id) =>
    (await q(`SELECT enrolled_at FROM staff WHERE user_id = $1`, [id]))[0]
      .enrolled_at;
  assert.equal((await at(confirmed)).toISOString().slice(0, 10), '2026-03-01');
  assert.equal((await at(onlyAudit)).toISOString().slice(0, 10), '2026-03-02');
  assert.equal(
    (await at(invitedThenEnrolled)).toISOString().slice(0, 10),
    '2026-03-03',
  );
  assert.equal((await at(noHistory)).toISOString().slice(0, 10), '2026-01-01');
  assert.ok(await at(started));
  assert.equal(await at(invited), null);
  assert.equal(await at(removedInvitee), null);
});
