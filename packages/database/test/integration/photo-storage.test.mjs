import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  avatarFor,
  deleteAccount,
  mailSealing,
  movePhotosToStore,
  removeAvatar,
  setAvatar,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

// Page photos kept in an object store (R2) instead of Postgres: the row keeps only the key, the
// photo is served only while the page is live, and no object outlives its photo or its account.

/** An in-memory stand-in for the R2 store; `failNextPut` makes the next upload fail. */
function memoryStore() {
  const objects = new Map();
  return {
    endpoint: 'memory://',
    objects,
    failNextPut: false,
    async put(key, webp) {
      if (this.failNextPut) {
        this.failNextPut = false;
        throw new Error('upload failed');
      }
      objects.set(key, Buffer.from(webp));
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const [{ user_id: userId }] = await rows(
    'SELECT user_id FROM profiles WHERE id = $1',
    [ADA],
  );
  return { ...database, rows, userId };
}

const webp = (label) => Buffer.from(`RIFF0000WEBPVP8 ${label}`);
const versionOf = (path) => Number(/\/(\d+)\.webp$/.exec(path)[1]);

test('with a store, the photo goes to the store and the row keeps only its key', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const store = memoryStore();
  const profile = await setAvatar(db, userId, webp('one'), store);
  const [row] = await rows(
    'SELECT bytes, object_key FROM profile_avatars WHERE profile_id = $1',
    [ADA],
  );
  assert.equal(row.bytes, null);
  assert.match(row.object_key, /^avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/);
  assert.deepEqual(store.objects.get(row.object_key), webp('one'));
  const served = await avatarFor(
    db,
    { profileId: ADA, version: versionOf(profile.avatarPath) },
    store,
  );
  assert.deepEqual(served, webp('one'));
});

test('a new photo replaces the old object; removing the photo removes its object', async (t) => {
  const { db, userId } = await fresh(t);
  const store = memoryStore();
  await setAvatar(db, userId, webp('one'), store);
  await setAvatar(db, userId, webp('two'), store);
  assert.equal(store.objects.size, 1, 'the first object is gone');
  assert.deepEqual([...store.objects.values()][0], webp('two'));
  await removeAvatar(db, userId, store);
  assert.equal(store.objects.size, 0);
});

test('a hidden page’s photo is not served, even though the object exists', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const store = memoryStore();
  const profile = await setAvatar(db, userId, webp('one'), store);
  await rows("UPDATE profiles SET status = 'suspended' WHERE id = $1", [ADA]);
  assert.equal(
    await avatarFor(
      db,
      { profileId: ADA, version: versionOf(profile.avatarPath) },
      store,
    ),
    null,
  );
  assert.equal(store.objects.size, 1);
});

test('a failed upload changes nothing: no row, no object, the old photo still served', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const store = memoryStore();
  const first = await setAvatar(db, userId, webp('one'), store);
  store.failNextPut = true;
  await assert.rejects(setAvatar(db, userId, webp('two'), store));
  const [row] = await rows(
    'SELECT version FROM profile_avatars WHERE profile_id = $1',
    [ADA],
  );
  assert.equal(row.version, versionOf(first.avatarPath));
  assert.equal(store.objects.size, 1);
});

test('deleting the account says which objects to remove, and they are no longer served', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const store = memoryStore();
  await setAvatar(db, userId, webp('one'), store);
  await rows("UPDATE tips SET status = 'FAILED' WHERE profile_id = $1", [ADA]);
  const result = await deleteAccount(db, {
    userId,
    sealing: mailSealing(Buffer.alloc(32, 7)),
    photos: store,
  });
  assert.equal(store.objects.size, 0, 'the photo is removed with the account');
  assert.ok(result.handle);
});

test('photos already in Postgres move to the store once, and keep being served', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const store = memoryStore();
  const profile = await setAvatar(db, userId, webp('legacy'));
  const moved = await movePhotosToStore(db, store);
  assert.equal(moved, 1);
  const [row] = await rows(
    'SELECT bytes, object_key FROM profile_avatars WHERE profile_id = $1',
    [ADA],
  );
  assert.equal(row.bytes, null);
  assert.deepEqual(store.objects.get(row.object_key), webp('legacy'));
  assert.deepEqual(
    await avatarFor(
      db,
      { profileId: ADA, version: versionOf(profile.avatarPath) },
      store,
    ),
    webp('legacy'),
  );
  assert.equal(
    await movePhotosToStore(db, store),
    0,
    'running it again moves nothing',
  );
});

test('without a store, photos stay in Postgres exactly as before', async (t) => {
  const { db, rows, userId } = await fresh(t);
  const profile = await setAvatar(db, userId, webp('db'));
  const [row] = await rows(
    'SELECT bytes, object_key FROM profile_avatars WHERE profile_id = $1',
    [ADA],
  );
  assert.equal(row.object_key, null);
  assert.deepEqual(
    await avatarFor(db, {
      profileId: ADA,
      version: versionOf(profile.avatarPath),
    }),
    webp('db'),
  );
});
