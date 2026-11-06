import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { useDatabase } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 1.2: the tables' checks and the migration's role grants.
const ADA_USER = '00000000-0000-7000-8000-00000000a0a1';
const SHA = 'a'.repeat(40);

const drizzle = new URL('../../drizzle/', import.meta.url);
const migration = readdirSync(drizzle).find((name) =>
  name.endsWith('_changelog.sql'),
);

/** The hand-written grants at the end of the migration: everything after the owner comment. */
function grantSql() {
  assert.ok(migration, 'the changelog migration exists');
  const text = readFileSync(new URL(migration, drizzle), 'utf8');
  const start = text.indexOf('-- ensureOwnerRole');
  assert.ok(start > 0, 'the grants are in the migration');
  return text.slice(start);
}

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.constraint ?? error.code;
  }
};

async function insertEntry(database, values = {}) {
  const row = {
    pr_number: 140,
    merge_sha: SHA,
    merged_at: '2026-11-06T10:00:00Z',
    pr_title: 'feat: pins',
    staff_text: 'feat: pins — Adds pins.',
    user_text: null,
    audience: 'staff',
    ...values,
  };
  const columns = Object.keys(row);
  return database.pool.query(
    `INSERT INTO changelog_entries (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}

test('a plain staff-only draft and a user-facing draft are stored with their defaults', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await insertEntry(database);
  await insertEntry(database, {
    pr_number: 141,
    user_text: '😀'.repeat(280),
    audience: 'everyone',
  });
  const { rows } = await database.pool.query(
    `SELECT pr_number, revision, published_revision, created_at IS NOT NULL AS created,
            updated_at IS NOT NULL AS updated
       FROM changelog_entries ORDER BY pr_number`,
  );
  assert.deepEqual(rows, [
    {
      pr_number: 140,
      revision: 1,
      published_revision: null,
      created: true,
      updated: true,
    },
    {
      pr_number: 141,
      revision: 1,
      published_revision: null,
      created: true,
      updated: true,
    },
  ]);
});

test('the checks refuse a bad sha, a 281-character user text, a user text with audience staff, and half-published rows', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const cases = [
    [{ merge_sha: 'a'.repeat(41) }, 'changelog_entries_merge_sha'],
    [{ merge_sha: 'A'.repeat(40) }, 'changelog_entries_merge_sha'],
    [{ pr_number: 0 }, 'changelog_entries_pr_number'],
    [{ pr_title: 'x'.repeat(257) }, 'changelog_entries_pr_title'],
    [{ staff_text: '' }, 'changelog_entries_staff_text'],
    [{ staff_text: 'x'.repeat(1001) }, 'changelog_entries_staff_text'],
    [
      { user_text: 'x'.repeat(281), audience: 'everyone' },
      'changelog_entries_user_text',
    ],
    [{ user_text: '', audience: 'everyone' }, 'changelog_entries_user_text'],
    [
      { user_text: 'You can pin.', audience: 'staff' },
      'changelog_entries_audience_staff',
    ],
    [
      { user_text: null, audience: 'everyone' },
      'changelog_entries_audience_staff',
    ],
    [{ audience: 'friends' }, 'changelog_entries_audience'],
    [
      { published_text: 'You can pin.' },
      'changelog_entries_published_together',
    ],
    [
      { published_text: 'You can pin.', published_audience: 'everyone' },
      'changelog_entries_published_together',
    ],
    [
      {
        published_text: 'x'.repeat(281),
        published_audience: 'everyone',
        published_revision: 1,
      },
      'changelog_entries_published_text',
    ],
    [
      {
        published_text: null,
        published_audience: 'friends',
        published_revision: 1,
      },
      'changelog_entries_published_audience',
    ],
    [{ revision: 0 }, 'changelog_entries_revision'],
    [{ live_version: 'abc' }, 'changelog_entries_live_version'],
  ];
  for (const [values, constraint] of cases)
    assert.equal(
      await failure(insertEntry(database, values)),
      constraint,
      JSON.stringify(values).slice(0, 80),
    );
  assert.equal(await database.count('changelog_entries'), 0);
  // An approval as staff only (a user text removed, then approved) is a whole published copy.
  await insertEntry(database, {
    published_text: null,
    published_audience: 'staff',
    published_revision: 2,
    revision: 2,
    live_version: 'abcdef012345',
  });
  assert.equal(await database.count('changelog_entries'), 1);
});

test('withdrawn columns are all set or all null', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  for (const values of [
    { withdrawn_at: '2026-11-06T11:00:00Z' },
    { withdrawn_at: '2026-11-06T11:00:00Z', withdrawn_by: ADA_USER },
    { withdrawn_by: ADA_USER, withdrawn_reason: 'Not shipped' },
    {
      withdrawn_at: '2026-11-06T11:00:00Z',
      withdrawn_by: ADA_USER,
      withdrawn_reason: '',
    },
  ])
    assert.equal(
      await failure(insertEntry(database, values)),
      'changelog_entries_withdrawn_together',
      JSON.stringify(values),
    );
  await insertEntry(database, {
    withdrawn_at: '2026-11-06T11:00:00Z',
    withdrawn_by: ADA_USER,
    withdrawn_reason: 'The change was rolled back',
  });
  assert.equal(await database.count('changelog_entries'), 1);
});

test('changelog_reads holds one timestamp per person', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await database.pool.query(
    `INSERT INTO changelog_reads (user_id, seen_through) VALUES ($1, now())`,
    [ADA_USER],
  );
  assert.equal(
    await failure(
      database.pool.query(
        `INSERT INTO changelog_reads (user_id, seen_through) VALUES ($1, now())`,
        [ADA_USER],
      ),
    ),
    'changelog_reads_pkey',
  );
  assert.equal(
    await failure(
      database.pool.query(
        `INSERT INTO changelog_reads (user_id, seen_through) VALUES (gen_random_uuid(), now())`,
      ),
    ),
    'changelog_reads_user_id_users_id_fk',
  );
  assert.equal(
    await failure(
      database.pool.query(
        `INSERT INTO changelog_reads (user_id, seen_through) VALUES ($1, NULL)
         ON CONFLICT (user_id) DO UPDATE SET seen_through = EXCLUDED.seen_through`,
        [ADA_USER],
      ),
    ),
    '23502',
  );
});

test('the user, admin and pending indexes exist', async (t) => {
  const database = await useDatabase(t);
  const { rows } = await database.pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'changelog_entries' ORDER BY indexname`,
  );
  const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
  assert.match(
    defs.changelog_entries_user_list,
    /live_at DESC NULLS LAST, pr_number DESC NULLS LAST\) WHERE/,
  );
  assert.match(defs.changelog_entries_user_list, /withdrawn_at IS NULL/);
  assert.match(
    defs.changelog_entries_user_list,
    /published_audience <> 'staff'/,
  );
  assert.match(defs.changelog_entries_merged, /merged_at DESC NULLS LAST/);
  assert.match(
    defs.changelog_entries_pending,
    /\(pr_number\) WHERE \(\(live_at IS NULL\) AND \(withdrawn_at IS NULL\)\)/,
  );
});

test('owner holds changelog.edit and changelog.publish; every other role except release_check holds changelog.edit', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  // reset() empties roles, so seed them as production has them, then run the migration's grants.
  await database.pool.query(
    `INSERT INTO roles (id, name, system) VALUES
       ('owner', 'Owner', true), ('release_check', 'Release check', true),
       ('r-support', 'Support', false), ('r-money', 'Money desk', false)`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('r-support', 'changelog.edit')`,
  );
  await database.pool.query(grantSql());
  // Running it again changes nothing.
  await database.pool.query(grantSql());
  const { rows } = await database.pool.query(
    `SELECT role_id, array_agg(permission ORDER BY permission) AS permissions
       FROM role_permissions WHERE permission LIKE 'changelog.%' GROUP BY role_id ORDER BY role_id`,
  );
  assert.deepEqual(rows, [
    { role_id: 'owner', permissions: ['changelog.edit', 'changelog.publish'] },
    { role_id: 'r-money', permissions: ['changelog.edit'] },
    { role_id: 'r-support', permissions: ['changelog.edit'] },
  ]);
});

test('role_permissions_known accepts both new permissions and still refuses an unknown one', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('r-editor', 'Editor')`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission)
     VALUES ('r-editor', 'changelog.edit'), ('r-editor', 'changelog.publish')`,
  );
  assert.equal(
    await failure(
      database.pool.query(
        `INSERT INTO role_permissions (role_id, permission) VALUES ('r-editor', 'changelog.delete')`,
      ),
    ),
    'role_permissions_known',
  );
  const { rows } = await database.pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'staff_permission_overrides_known'`,
  );
  assert.match(rows[0].def, /changelog\.edit/);
  assert.match(rows[0].def, /changelog\.publish/);
});
