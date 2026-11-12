import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DashboardController } from '../../apps/api/dist/dashboard/dashboard.controller.js';
import {
  recordClientEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';

test('the owner sees today’s visits only while analytics are collected', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await recordClientEvent(database.db, {
    event: {
      name: 'profile_viewed',
      flowId: randomUUID(),
      surface: 'profile',
      handle: 'tobi',
    },
    device: 'mobile',
  });
  const visits = (enabled) =>
    new DashboardController({ db: database.db }, {}, { enabled }).visits({
      userId: TOBI_USER,
    });
  assert.deepEqual((await visits(true)).data, { visits: 1 });
  // Off in production until D-07: no number at all, rather than a misleading zero.
  assert.deepEqual((await visits(false)).data, { visits: null });
});
