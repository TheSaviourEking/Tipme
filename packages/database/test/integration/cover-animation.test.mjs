import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteAccount,
  getMyProfile,
  publicProfile,
  setCoverDesign,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const ADA_USER = '00000000-0000-7000-8000-00000000a0a1';

const errorCode = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code;
  }
};

const coverRow = async (database) =>
  (
    await database.pool.query(
      `SELECT cover_design, cover_colour, cover_animation, cover_motion, xmin::text AS xmin
         FROM profiles WHERE id = $1`,
      [ADA],
    )
  ).rows[0];

const setPlan = (database, plan) =>
  database.pool.query('UPDATE profiles SET plan = $2 WHERE id = $1', [
    ADA,
    plan,
  ]);

test('a Free page saving a Pro animation, a loop or a colour is refused and nothing changes', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const before = await coverRow(database);
  for (const choice of [
    { design: null, animation: 'night' },
    { design: null, animation: 'drift', motion: 'loop' },
    { design: null, animation: 'drift', colour: 'ocean' },
  ])
    assert.equal(
      await errorCode(setCoverDesign(database.db, ADA_USER, choice)),
      'COVER_DESIGN_PRO_REQUIRED',
    );
  assert.deepEqual(await coverRow(database), before);
});

test('a Free page saves drift with no motion; coverChoice shows it and cover plays once', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { profile, changed } = await setCoverDesign(database.db, ADA_USER, {
    design: null,
    animation: 'drift',
  });
  assert.equal(changed, true);
  assert.equal(profile.coverChoice.animation, 'drift');
  assert.equal(profile.coverChoice.motion, null);
  assert.deepEqual(profile.cover, {
    kind: 'animated',
    animation: 'drift',
    play: 'once',
  });
});

test('a Pro page saves night, ocean and loop; choosing a still design clears the animation', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await setPlan(database, 'pro');
  const { profile } = await setCoverDesign(database.db, ADA_USER, {
    design: null,
    animation: 'night',
    colour: 'ocean',
    motion: 'loop',
  });
  assert.deepEqual(profile.cover, {
    kind: 'animated',
    animation: 'night',
    colour: 'ocean',
    play: 'loop',
  });
  assert.equal(profile.coverChoice.motion, 'loop');
  const still = await setCoverDesign(database.db, ADA_USER, {
    design: 'dark',
  });
  assert.equal(still.profile.coverChoice.animation, null);
  assert.equal(still.profile.coverChoice.motion, null);
  const row = await coverRow(database);
  assert.equal(row.cover_animation, null);
  assert.equal(row.cover_motion, null);
  assert.equal(row.cover_design, 'dark');
});

test('the plan dropping between read and write refuses the save', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await setPlan(database, 'pro');
  const before = await coverRow(database);
  const other = await database.pool.connect();
  try {
    await other.query('BEGIN');
    // Holds the page's row, so the save reads Pro and then waits to write.
    await other.query("UPDATE profiles SET plan = 'free' WHERE id = $1", [ADA]);
    const saving = errorCode(
      setCoverDesign(database.db, ADA_USER, {
        design: null,
        animation: 'night',
        motion: 'loop',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    await other.query('COMMIT');
    assert.equal(await saving, 'COVER_DESIGN_PRO_REQUIRED');
  } finally {
    other.release();
  }
  const after = await coverRow(database);
  assert.equal(after.cover_animation, before.cover_animation);
  assert.equal(after.cover_motion, before.cover_motion);
});

test('saving the same Pro choice again is unchanged, not refused', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await setPlan(database, 'pro');
  const choice = { design: null, animation: 'pulse', motion: 'loop' };
  assert.equal(
    (await setCoverDesign(database.db, ADA_USER, choice)).changed,
    true,
  );
  assert.equal(
    (await setCoverDesign(database.db, ADA_USER, choice)).changed,
    false,
  );
});

test('deleting the account clears the animation and motion', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await setPlan(database, 'pro');
  await setCoverDesign(database.db, ADA_USER, {
    design: null,
    animation: 'night',
    motion: 'loop',
  });
  await deleteAccount(database.db, { userId: ADA_USER });
  const row = await coverRow(database);
  assert.equal(row.cover_animation, null);
  assert.equal(row.cover_motion, null);
  assert.equal(await publicProfile(database.db, 'ada'), null);
});

test('cover_motion accepts only once and loop', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  for (const ok of ['once', 'loop', null])
    await database.pool.query(
      'UPDATE profiles SET cover_motion = $2 WHERE id = $1',
      [ADA, ok],
    );
  await assert.rejects(
    database.pool.query(
      "UPDATE profiles SET cover_motion = 'bounce' WHERE id = $1",
      [ADA],
    ),
    /cover_motion|check/i,
  );
  assert.ok(await getMyProfile(database.db, ADA_USER));
});
