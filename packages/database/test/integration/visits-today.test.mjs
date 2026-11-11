import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  recordClientEvent,
  visitsToday,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

test('visits today count each browsing session that opened the page once, on the Lagos day', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const view = (handle, flowId, now, name = 'profile_viewed') =>
    recordClientEvent(db, {
      event: { name, flowId, surface: 'profile', handle },
      device: 'mobile',
      now,
    });
  const now = lagos('2026-10-27T15:00:00');
  assert.equal(await visitsToday(db, { profileId: TOBI.id, now }), 0);

  const morning = randomUUID();
  await view('tobi', morning, lagos('2026-10-27T08:00:00'));
  // The same session opening the page again is still one visit; the handle's case doesn't matter.
  await view('Tobi', morning, lagos('2026-10-27T08:05:00'));
  await view('tobi', randomUUID(), lagos('2026-10-27T14:59:00'));
  // Not counted: yesterday in Lagos (though today in UTC is the same date), another page,
  // another kind of event.
  await view('tobi', randomUUID(), lagos('2026-10-26T23:30:00'));
  await view('ada', randomUUID(), lagos('2026-10-27T09:00:00'));
  await view(
    'tobi',
    randomUUID(),
    lagos('2026-10-27T09:00:00'),
    'tip_cta_clicked',
  );

  assert.equal(await visitsToday(db, { profileId: TOBI.id, now }), 2);
  assert.equal(await visitsToday(db, { profileId: ADA.id, now }), 1);
});
