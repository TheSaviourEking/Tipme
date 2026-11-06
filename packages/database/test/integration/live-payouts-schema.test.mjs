import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import {
  createDatabase,
  resolveIssue,
  seedDemoProfiles,
} from '../../dist/index.js';
import { MIGRATIONS_FOLDER } from '../../dist/migrations.js';
import { ADA, useDatabase } from './helpers.mjs';

/** Runs `work`, expecting Postgres to refuse it with a constraint of this name. */
async function refuses(constraint, work) {
  await assert.rejects(work, (error) => error.constraint === constraint);
}

const destination = (profileId, overrides = {}) => ({
  id: randomUUID(),
  profileId,
  provider: 'bachs',
  destinationReference: `dest-${randomUUID()}`,
  bankCode: '058',
  bankName: 'Example Bank',
  last4: '6789',
  status: 'usable',
  ...overrides,
});

test('live payouts schema: constraints', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) => database.pool.query(sql, params);
  const addDestination = (d) =>
    q(
      `INSERT INTO payout_destinations
         (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        d.id,
        d.profileId,
        d.provider,
        d.destinationReference,
        d.bankCode,
        d.bankName,
        d.last4,
        d.status,
      ],
    );
  const issue = async () => {
    const id = randomUUID();
    await q(
      `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
       VALUES ($1, $2, 'payout_unexpected', 'money', '{}', 'x', now())`,
      [id, `k.${id}`],
    );
    return id;
  };
  const payout = async () => {
    const id = randomUUID();
    await q(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
       VALUES ($1, $2, 'NGN', 1000, 'REQUESTED', $3, 'f')`,
      [id, ADA, `k-${id}`],
    );
    return id;
  };

  await t.test('destinations', async () => {
    await addDestination(destination(ADA));
    await refuses('payout_destinations_status', () =>
      addDestination(destination(ADA, { provider: 'other', status: 'weird' })),
    );
    // A full account number cannot be stored: the column is four characters wide.
    await assert.rejects(() =>
      addDestination(
        destination(ADA, { provider: 'other', last4: '0123456789' }),
      ),
    );
    await refuses('payout_destinations_last4', () =>
      addDestination(destination(ADA, { provider: 'other', last4: '12ab' })),
    );
    // Short values are padded by char(4), so the check must see only digits.
    await refuses('payout_destinations_last4', () =>
      addDestination(destination(ADA, { provider: 'other', last4: '123' })),
    );
    // The stored provider name is 'bachs', never an adapter name.
    for (const provider of ['bachs-live', 'bachs-sandbox', 'Bachs'])
      await refuses('payout_destinations_provider', () =>
        addDestination(destination(ADA, { provider })),
      );
    // One active destination per profile and provider.
    await assert.rejects(
      () => addDestination(destination(ADA)),
      (error) => error.constraint === 'payout_destinations_active',
    );
    // A replaced one makes room for a new active one.
    await q(
      `UPDATE payout_destinations SET replaced_at = now() WHERE profile_id = $1`,
      [ADA],
    );
    await addDestination(destination(ADA));
    await addDestination(destination(ADA, { provider: 'mock' }));
  });

  await t.test('payout fee columns', async () => {
    const id = await payout();
    const row = (await q('SELECT * FROM payouts WHERE id = $1', [id])).rows[0];
    for (const column of [
      'destination_id',
      'fee_minor',
      'fee_transfer_reference',
      'start_uncertain_at',
      'account_reference',
    ])
      assert.equal(row[column], null, column);
    await q(`UPDATE payouts SET fee_minor = 0 WHERE id = $1`, [id]);
    await q(`UPDATE payouts SET fee_minor = 5000 WHERE id = $1`, [id]);
    await refuses('payouts_fee_not_negative', () =>
      q(`UPDATE payouts SET fee_minor = -1 WHERE id = $1`, [id]),
    );
    await refuses('payouts_destination_id_payout_destinations_id_fk', () =>
      q(`UPDATE payouts SET destination_id = $2 WHERE id = $1`, [
        id,
        randomUUID(),
      ]),
    );
  });

  await t.test('payment account columns', async () => {
    const cols = (
      await q(
        `SELECT column_name, is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'payment_accounts'
            AND column_name IN ('manual_payouts_at', 'payout_capabilities_requested_at')`,
      )
    ).rows;
    assert.equal(cols.length, 2);
    for (const c of cols) {
      assert.equal(c.is_nullable, 'YES');
      assert.equal(c.data_type, 'timestamp with time zone');
    }
  });

  await t.test('withdrawal holds', async () => {
    const issueId = await issue();
    const hold = (reason, issue = issueId) =>
      q(
        `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), ADA, reason, issue],
      );
    for (const reason of ['reversal', 'in_debt', 'unexpected_payout'])
      await hold(reason);
    // released_by only goes with released_at.
    const heldId = randomUUID();
    await q(
      `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id) VALUES ($1, $2, 'reversal', $3)`,
      [heldId, ADA, issueId],
    );
    await refuses('withdrawal_holds_release', () =>
      q(`UPDATE withdrawal_holds SET released_by = $2 WHERE id = $1`, [
        heldId,
        randomUUID(),
      ]),
    );
    await q(
      `UPDATE withdrawal_holds SET released_at = now(), released_by = $2 WHERE id = $1`,
      [heldId, randomUUID()],
    );
    await refuses('withdrawal_holds_reason', () => hold('because'));
    await refuses('withdrawal_holds_issue_id_issues_id_fk', () =>
      hold('reversal', randomUUID()),
    );
    const plan = (
      await q(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'withdrawal_holds'`,
      )
    ).rows.map((r) => r.indexdef);
    assert.ok(
      plan.some(
        (d) => d.includes('(profile_id)') && d.includes('released_at IS NULL'),
      ),
      plan.join('\n'),
    );
  });

  await t.test('provider fee credits', async () => {
    const payoutId = await payout();
    const credit = (overrides = {}) => {
      const v = {
        account: 'acct_1',
        provider: 'bachs',
        amount: 500,
        currency: 'NGN',
        transfer: `tr-${randomUUID()}`,
        ...overrides,
      };
      return q(
        `INSERT INTO provider_fee_credits
           (account_reference, provider, amount_minor, transfer_reference, payout_id, currency)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [v.account, v.provider, v.amount, v.transfer, payoutId, v.currency],
      );
    };
    await credit({ transfer: 'tr-one' });
    await refuses('provider_fee_credits_pkey', () =>
      credit({ transfer: 'tr-one' }),
    );
    await refuses('provider_fee_credits_provider', () =>
      credit({ provider: 'bachs-live' }),
    );
    await refuses('provider_fee_credits_currency_iso', () =>
      credit({ currency: 'ngn' }),
    );
    await refuses('provider_fee_credits_amount_positive', () =>
      credit({ amount: 0 }),
    );
    const row = (
      await q(`SELECT used_by_payout_id, created_at FROM provider_fee_credits`)
    ).rows[0];
    assert.equal(row.used_by_payout_id, null);
    assert.ok(row.created_at);

    // A credit is spent once: the first spend works, any later change is refused.
    const spender = await payout();
    const other = await payout();
    const spend = (by) =>
      q(
        `UPDATE provider_fee_credits SET used_by_payout_id = $1 WHERE transfer_reference = 'tr-one'`,
        [by],
      );
    await spend(spender);
    await assert.rejects(() => spend(other), /spent/);
    await assert.rejects(() => spend(null), /spent/);
    await spend(spender); // writing the same value again changes nothing
    // A spend by a payout in another currency is refused.
    await credit({ transfer: 'tr-two' });
    const usd = randomUUID();
    await q(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
       VALUES ($1, $2, 'USD', 1000, 'REQUESTED', $3, 'f')`,
      [usd, ADA, `k-${usd}`],
    );
    await assert.rejects(
      () =>
        q(
          `UPDATE provider_fee_credits SET used_by_payout_id = $1 WHERE transfer_reference = 'tr-two'`,
          [usd],
        ),
      /currency/,
    );
  });

  await t.test('issues: new kinds and resolution outcomes', async () => {
    for (const kind of [
      'payout_unexpected',
      'payout_unresolved',
      'provider_in_debt',
    ])
      await q(
        `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
         VALUES ($1, $2, $3, 'money', '{}', 'x', now())`,
        [randomUUID(), `k.${randomUUID()}`, kind],
      );
    const outcome = async (value, status = 'resolved') => {
      const id = randomUUID();
      await q(
        `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at,
                             status, resolved_at, resolved_by, resolution_outcome)
         VALUES ($1, $2, 'payout_failed', 'money', '{}', 'x', now(), $3,
                 CASE WHEN $3 = 'open' THEN NULL ELSE now() END,
                 CASE WHEN $3 = 'open' THEN NULL ELSE 'system' END, $4)`,
        [id, `k.${id}`, status, value],
      );
    };
    for (const value of [
      'resolved_by_provider',
      'recipient_owes',
      'written_off',
      null,
    ])
      await outcome(value);
    // Staff resolution stores the outcome and changes no balance.
    const staffIssue = await issue();
    await resolveIssue(database.db, {
      issueId: staffIssue,
      staffUserId: randomUUID(),
      reason: 'The provider settled it directly.',
      outcome: 'resolved_by_provider',
    });
    const stored = await q(
      'SELECT status, resolution_outcome FROM issues WHERE id = $1',
      [staffIssue],
    );
    assert.deepEqual(stored.rows[0], {
      status: 'resolved',
      resolution_outcome: 'resolved_by_provider',
    });
    await refuses('issues_resolution_outcome', () => outcome('forgiven'));
    await refuses('issues_resolution_outcome', () =>
      outcome('written_off', 'open'),
    );
  });
});

test('live payouts schema: applies on top of existing payouts', async (t) => {
  const database = await useDatabase(t);
  const name = `tipme_upgrade_${process.pid}`;
  assert.match(name, /^[a-z_0-9]+$/);
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(database.url);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // pool.end() returns before its connections have closed, so the forced drop below can end one
  // that is still closing. Without a listener that error fails the test.
  pool.on('error', () => undefined);
  const folder = await mkdtemp(join(tmpdir(), 'tipme-migrations-'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  });
  // The previous release's schema: every migration before this one.
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const mine = journal.entries.findIndex((e) => e.tag === '0052_live_payouts');
  assert.ok(mine > 0, 'journal lists 0052_live_payouts');
  journal.entries = journal.entries.slice(0, mine);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: folder });
  assert.equal(
    (await pool.query(`SELECT to_regclass('payout_destinations') AS t`)).rows[0]
      .t,
    null,
  );

  // A payout written by the previous release, before the new columns exist.
  const old = createDatabase(url.toString());
  t.after(() => old.close());
  // The seed writes today's users columns; this one arrives with a later migration.
  // Likewise the profile columns that handle changes and covers add (0062, 0063), and the
  // social links list (0074_social_links), the live-update switches (0075_live_popup_prefs), the thank-you line (0076_note_consent_and_thanks), and the cover animation (0077_cover_animation).
  await pool.query(
    `ALTER TABLE profiles
       ADD COLUMN handle_changes_used integer NOT NULL DEFAULT 0,
       ADD COLUMN handle_changes_extra integer NOT NULL DEFAULT 0,
       ADD COLUMN cover_design text,
       ADD COLUMN cover_colour text,
       ADD COLUMN cover_path text,
       ADD COLUMN cover_version integer NOT NULL DEFAULT 0,
       ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb,
       ADD COLUMN popup_hide_tip_details boolean NOT NULL DEFAULT false,
       ADD COLUMN tip_sound boolean NOT NULL DEFAULT true,
       ADD COLUMN thanks_line text,
       ADD COLUMN thanks_style text,
       ADD COLUMN thanks_signed boolean NOT NULL DEFAULT false,
       ADD COLUMN cover_animation text,
       ADD COLUMN cover_motion text`,
  );
  await pool.query(`ALTER TABLE users ADD COLUMN email_changed_at timestamptz`);
  await seedDemoProfiles(old.db);
  await pool.query(`ALTER TABLE users DROP COLUMN email_changed_at`);
  await pool.query(
    `ALTER TABLE profiles
       DROP COLUMN handle_changes_used,
       DROP COLUMN handle_changes_extra,
       DROP COLUMN cover_design,
       DROP COLUMN cover_colour,
       DROP COLUMN cover_path,
       DROP COLUMN cover_version,
       DROP COLUMN links,
       DROP COLUMN popup_hide_tip_details,
       DROP COLUMN tip_sound,
       DROP COLUMN thanks_line,
       DROP COLUMN thanks_style,
       DROP COLUMN thanks_signed,
       DROP COLUMN cover_animation,
       DROP COLUMN cover_motion`,
  );
  const payoutId = randomUUID();
  await pool.query(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 'NGN', 1000, 'REQUESTED', 'old-key', 'f')`,
    [payoutId, ADA],
  );
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  const row = (
    await pool.query('SELECT * FROM payouts WHERE id = $1', [payoutId])
  ).rows[0];
  assert.equal(row.amount_minor, '1000');
  for (const column of [
    'destination_id',
    'fee_minor',
    'fee_transfer_reference',
    'start_uncertain_at',
    'account_reference',
  ])
    assert.equal(row[column], null, column);
  // The previous release's insert (no new columns) still works.
  await pool.query(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 'NGN', 2000, 'REQUESTED', 'old-key-2', 'f')`,
    [randomUUID(), ADA],
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM payout_destinations'))
      .rows[0].n,
    0,
  );
});
