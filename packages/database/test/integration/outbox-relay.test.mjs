import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { relayOutboxOnce } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('outbox relay', async (t) => {
  const database = await useDatabase(t);
  const addRows = async (n) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await database.pool.query(
        `INSERT INTO outbox_events (id, event_type, aggregate_id, dedupe_key, payload, trace)
         VALUES ($1, 'tip.succeeded', $1, $2, '{"tipId":"x"}', '{"traceparent":"00-${'a'.repeat(32)}-${'b'.repeat(16)}-01"}')`,
        [id, `tip.succeeded.${id}`],
      );
    }
  };
  const unpublished = async () =>
    (
      await database.pool.query(
        'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
      )
    ).rows[0].n;

  await t.test('publishes each committed row and marks it', async () => {
    await database.fresh();
    await addRows(3);
    const seen = [];
    assert.equal(
      await relayOutboxOnce(database.db, async (row) => {
        seen.push(row);
      }),
      3,
    );
    assert.equal(
      await relayOutboxOnce(database.db, async (row) => {
        seen.push(row);
      }),
      0,
    );
    assert.equal(seen.length, 3);
    assert.equal(await unpublished(), 0);
    assert.match(seen[0].dedupeKey, /^tip\.succeeded\./);
    assert.match(seen[0].trace.traceparent, /^00-/);
  });

  await t.test(
    'a publish failure marks nothing and the next run delivers everything',
    async () => {
      await database.fresh();
      await addRows(3);
      let calls = 0;
      await assert.rejects(
        relayOutboxOnce(database.db, async () => {
          calls += 1;
          if (calls === 2) throw new Error('redis down');
        }),
        /redis down/,
      );
      assert.equal(await unpublished(), 3);
      const attempts = (
        await database.pool.query(
          'SELECT attempts FROM outbox_events ORDER BY created_at',
        )
      ).rows.map((row) => row.attempts);
      assert.deepEqual(attempts, [1, 1, 1], 'failed deliveries are counted');
      assert.equal(await relayOutboxOnce(database.db, async () => {}), 3);
    },
  );

  await t.test(
    'two relays at once never publish the same row twice',
    async () => {
      await database.fresh();
      await addRows(6);
      const published = [];
      const slow = async (row) => {
        await sleep(20);
        published.push(row.id);
      };
      await Promise.all([
        relayOutboxOnce(database.db, slow, 3),
        relayOutboxOnce(database.db, slow, 3),
      ]);
      assert.equal(published.length, 6);
      assert.equal(new Set(published).size, 6);
    },
  );
});
