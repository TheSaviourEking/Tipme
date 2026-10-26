import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  avatarBytes,
  deleteAccount,
  DEMO_PROFILES,
  getMyProfile,
  grantOwner,
  removeAvatarByStaff,
  setMyAvatar,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA] = DEMO_PROFILES;
const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const chunk = (id, data) => [
  ...ascii(id),
  ...u32(data.length),
  ...data,
  ...(data.length % 2 ? [0] : []),
];
const webp = (...extra) => {
  const body = [
    ...ascii('WEBP'),
    ...chunk('VP8 ', [
      0x10,
      0x02,
      0x00,
      0x9d,
      0x01,
      0x2a,
      960 & 255,
      960 >> 8,
      1200 & 255,
      1200 >> 8,
      0,
      0,
    ]),
    ...extra.flat(),
  ];
  return Uint8Array.from([...ascii('RIFF'), ...u32(body.length), ...body]);
};
const idOf = (path) => /\/avatars\/(.+)\.webp$/.exec(path)[1];

test('profile photos', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const count = async () =>
    (await database.pool.query('SELECT count(*)::int AS n FROM avatars'))
      .rows[0].n;

  await t.test(
    'a plain WebP is stored and served; metadata is refused',
    async () => {
      await database.fresh();
      await assert.rejects(
        setMyAvatar(db, {
          userId: ADA.userId,
          bytes: webp(chunk('EXIF', [1, 2, 3, 4])),
        }),
        { code: 'INVALID_INPUT' },
      );
      const { avatarPath } = await setMyAvatar(db, {
        userId: ADA.userId,
        bytes: webp(),
      });
      assert.match(avatarPath, /^\/avatars\/[0-9a-f-]{36}\.webp$/);
      assert.equal((await getMyProfile(db, ADA.userId)).avatarPath, avatarPath);
      assert.deepEqual(
        new Uint8Array(await avatarBytes(db, idOf(avatarPath))),
        webp(),
      );

      // Replacing keeps exactly one photo, and the old one is gone.
      const second = await setMyAvatar(db, {
        userId: ADA.userId,
        bytes: webp(),
      });
      assert.equal(await count(), 1);
      assert.equal(await avatarBytes(db, idOf(avatarPath)), null);
      assert.notEqual(second.avatarPath, avatarPath);
    },
  );

  await t.test(
    'staff removal is audited; deleting the account deletes the bytes',
    async () => {
      await database.fresh();
      const { userId: staff } = await grantOwner(db, {
        phone: '+2348000009998',
      });
      await setMyAvatar(db, { userId: ADA.userId, bytes: webp() });
      await removeAvatarByStaff(db, {
        profileId: ADA.id,
        staffUserId: staff,
        reason: 'Photo of someone else',
      });
      assert.equal((await getMyProfile(db, ADA.userId)).avatarPath, null);
      assert.equal(await count(), 0);
      const [audit] = (
        await database.pool.query(
          `SELECT action, reason FROM audit_events WHERE subject_id = $1`,
          [ADA.id],
        )
      ).rows;
      assert.deepEqual(audit, {
        action: 'avatar.removed',
        reason: 'Photo of someone else',
      });

      await setMyAvatar(db, { userId: ADA.userId, bytes: webp() });
      await deleteAccount(db, { userId: ADA.userId });
      assert.equal(await count(), 0);
    },
  );
});
