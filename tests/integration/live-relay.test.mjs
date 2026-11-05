import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startOutboxRelay } from '../../apps/worker/dist/outbox-relay-loop.js';
import { enqueueOutbox } from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';

// It resets its database and runs a relay that claims every unpublished row: never run it beside
// other files on one shared database. `pnpm test:integration` gives each file its own copy; on a
// lane database run files one at a time (--test-concurrency=1).
// The relay's live signals against a real database, with no stack: nothing else claims the rows.
// (A relay running beside this one would; that is why these are not in outbox-delivery.test.mjs.)

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
});
after(() => database?.close());

const logger = { info() {}, warn() {}, error() {} };

async function addTipEvent() {
  const profileId = randomUUID();
  const tipId = randomUUID();
  await database.db.transaction((tx) =>
    enqueueOutbox(tx, {
      eventType: 'tip.succeeded',
      aggregateId: tipId,
      payload: { tipId, profileId },
    }),
  );
  return { profileId, dedupeKey: `tip.succeeded.${tipId}` };
}

const publishedAt = async (dedupeKey) =>
  (
    await database.pool.query(
      'SELECT published_at FROM outbox_events WHERE dedupe_key = $1',
      [dedupeKey],
    )
  ).rows[0].published_at;

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

test('relay publishes nothing when queue.add fails (the claim rolls back)', async () => {
  await database.reset();
  const { dedupeKey } = await addTipEvent();
  const published = [];
  let adds = 0;
  const relay = startOutboxRelay({
    db: database.db,
    logger,
    intervalMs: 20,
    maxBackoffMs: 40,
    queue: {
      add: async () => {
        adds += 1;
        throw new Error('Connection is closed.');
      },
    },
    publishLive: async (messages) => void published.push(...messages),
  });
  try {
    assert.equal(await until(() => adds >= 3), true);
  } finally {
    await relay.stop();
  }
  assert.deepEqual(published, []);
  assert.equal(await publishedAt(dedupeKey), null);
});

test('a publish that rejects is swallowed and the relay still marks its rows relayed', async () => {
  await database.reset();
  const { profileId, dedupeKey } = await addTipEvent();
  const added = [];
  const calls = [];
  const relay = startOutboxRelay({
    db: database.db,
    logger,
    intervalMs: 20,
    queue: { add: async (name) => void added.push(name) },
    publishLive: async (messages) => {
      calls.push(messages);
      throw new Error('Connection is closed.');
    },
  });
  try {
    assert.equal(
      await until(async () => (await publishedAt(dedupeKey)) !== null),
      true,
    );
    await until(() => calls.length > 0);
  } finally {
    await relay.stop();
  }
  assert.deepEqual(added, ['tip.succeeded']);
  assert.deepEqual(calls[0], [
    { to: { profile: profileId }, type: 'tips.changed' },
  ]);
  // Marked once, and not claimed again because a publish failed.
  await sleep(100);
  assert.equal(added.length, 1);
});

test('the relay publishes after the claim commits, never inside it', async () => {
  await database.reset();
  const { dedupeKey } = await addTipEvent();
  let seenAtPublish;
  const relay = startOutboxRelay({
    db: database.db,
    logger,
    intervalMs: 20,
    queue: { add: async () => undefined },
    // A second connection: inside the claim it would still see the row unpublished.
    publishLive: async () => {
      seenAtPublish = await publishedAt(dedupeKey);
    },
  });
  try {
    assert.equal(await until(() => seenAtPublish !== undefined), true);
  } finally {
    await relay.stop();
  }
  assert.notEqual(seenAtPublish, null);
});
