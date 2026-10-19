import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openTestDatabase } from '../../dist/test-support.js';

let database;
let pool;
before(async () => {
  database = await openTestDatabase();
  pool = database.pool;
});
beforeEach(() => database.reset());
after(() => database.close());

async function accountsAndTransaction(client, currency = 'NGN') {
  const [debitAccount, creditAccount, txn] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await client.query(
    `INSERT INTO ledger_accounts (id, code, kind, currency) VALUES ($1, 'provider_clearing', 'asset', $3), ($2, 'platform_fee_revenue', 'revenue', $3)`,
    [debitAccount, creditAccount, currency],
  );
  await client.query(
    `INSERT INTO ledger_transactions (id, operation_type, operation_key, currency) VALUES ($1, 'payment', $2, $3)`,
    [txn, `test.${txn}`, currency],
  );
  return { debitAccount, creditAccount, txn };
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const entry = (client, txn, account, side, amount, currency = 'NGN') =>
  client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_id, side, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), txn, account, side, amount, currency],
  );

test('balanced ledger transactions commit; history cannot be edited or deleted', async () => {
  let ids;
  await inTransaction(async (client) => {
    ids = await accountsAndTransaction(client);
    await entry(client, ids.txn, ids.debitAccount, 'debit', 100);
    await entry(client, ids.txn, ids.creditAccount, 'credit', 100);
  });
  await assert.rejects(
    pool.query('UPDATE ledger_entries SET amount_minor = 1'),
    /append-only/,
  );
  await assert.rejects(pool.query('DELETE FROM ledger_entries'), /append-only/);
  await assert.rejects(
    pool.query('DELETE FROM ledger_transactions'),
    /append-only/,
  );
  await pool.query(
    `INSERT INTO status_transitions (id, entity_type, entity_id, to_status, cause) VALUES ($1, 'tip', $2, 'AWAITING_PAYMENT', 'system')`,
    [randomUUID(), randomUUID()],
  );
  await assert.rejects(
    pool.query('DELETE FROM status_transitions'),
    /append-only/,
  );
  await assert.rejects(
    pool.query(`UPDATE status_transitions SET to_status = 'SUCCEEDED'`),
    /append-only/,
  );
});

test('entries can never be added to a transaction committed earlier', async () => {
  let ids;
  await inTransaction(async (client) => {
    ids = await accountsAndTransaction(client);
    await entry(client, ids.txn, ids.debitAccount, 'debit', 100);
    await entry(client, ids.txn, ids.creditAccount, 'credit', 100);
  });
  await assert.rejects(
    inTransaction(async (client) => {
      await entry(client, ids.txn, ids.debitAccount, 'debit', 50);
      await entry(client, ids.txn, ids.creditAccount, 'credit', 50);
    }),
    /closed/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0]
      .n,
    2,
  );
});

test('history tables cannot be truncated and accounts cannot be changed', async () => {
  await assert.rejects(
    pool.query('TRUNCATE ledger_entries CASCADE'),
    /TRUNCATE/,
  );
  await assert.rejects(pool.query('TRUNCATE status_transitions'), /TRUNCATE/);
  await pool.query(
    `INSERT INTO ledger_accounts (id, code, kind, currency) VALUES ($1, 'provider_clearing', 'asset', 'NGN')`,
    [randomUUID()],
  );
  await assert.rejects(
    pool.query(`UPDATE ledger_accounts SET currency = 'USD'`),
    /append-only/,
  );
  await assert.rejects(
    pool.query('DELETE FROM ledger_accounts'),
    /append-only/,
  );
});

test('an entry must belong to the same recipient as its account', async () => {
  const profile = randomUUID();
  await pool.query(
    `INSERT INTO profiles (id, handle, handle_lower, display_name) VALUES ($1, 'p', 'p', 'P')`,
    [profile],
  );
  await assert.rejects(
    inTransaction(async (client) => {
      const ids = await accountsAndTransaction(client);
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, profile_id, side, amount_minor, currency) VALUES ($1, $2, $3, $4, 'debit', 100, 'NGN')`,
        [randomUUID(), ids.txn, ids.debitAccount, profile],
      );
    }),
    /profile/,
  );
});

test('an unbalanced transaction fails at commit', async () => {
  await assert.rejects(
    inTransaction(async (client) => {
      const ids = await accountsAndTransaction(client);
      await entry(client, ids.txn, ids.debitAccount, 'debit', 100);
      await entry(client, ids.txn, ids.creditAccount, 'credit', 90);
    }),
    /unbalanced/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0]
      .n,
    0,
  );
});

test('a single-entry transaction fails at commit', async () => {
  await assert.rejects(
    inTransaction(async (client) => {
      const ids = await accountsAndTransaction(client);
      await entry(client, ids.txn, ids.debitAccount, 'debit', 100);
    }),
    /unbalanced/,
  );
});

test('a transaction with no entries fails at commit', async () => {
  await assert.rejects(
    inTransaction(async (client) => {
      await accountsAndTransaction(client);
    }),
    /unbalanced/,
  );
});

test('entry currency must match its account and transaction', async () => {
  await assert.rejects(
    inTransaction(async (client) => {
      const ids = await accountsAndTransaction(client);
      await entry(client, ids.txn, ids.debitAccount, 'debit', 100, 'USD');
    }),
    /currency/,
  );
});

test('money amounts must be positive and currencies ISO-shaped', async () => {
  await assert.rejects(
    inTransaction(async (client) => {
      const ids = await accountsAndTransaction(client);
      await entry(client, ids.txn, ids.debitAccount, 'debit', 0);
    }),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO ledger_accounts (id, code, kind, currency) VALUES ($1, 'x', 'asset', 'ngn')`,
      [randomUUID()],
    ),
  );
});

test('unverified provider events are never stored, and provider event IDs are unique', async () => {
  const insert = (verified, eventId) =>
    pool.query(
      `INSERT INTO provider_events (id, provider, provider_event_id, event_type, signature_verified, payload_hash, payload)
       VALUES ($1, 'mock', $2, 'payment.succeeded', $3, 'h', '{}'::jsonb)`,
      [randomUUID(), eventId, verified],
    );
  await assert.rejects(insert(false, 'evt-1'));
  await insert(true, 'evt-2');
  await assert.rejects(insert(true, 'evt-2'), /duplicate key/);
});

test('handles are unique regardless of case', async () => {
  const insert = (handle) =>
    pool.query(
      `INSERT INTO profiles (id, handle, handle_lower, display_name) VALUES ($1, $2, lower($2), 'x')`,
      [randomUUID(), handle],
    );
  await insert('Ada');
  await assert.rejects(insert('ada'), /duplicate key/);
});

test('global ledger accounts are unique per code and currency even without a profile', async () => {
  const insert = () =>
    pool.query(
      `INSERT INTO ledger_accounts (id, code, kind, currency) VALUES ($1, 'provider_clearing', 'asset', 'NGN')`,
      [randomUUID()],
    );
  await insert();
  await assert.rejects(insert(), /duplicate key/);
});
