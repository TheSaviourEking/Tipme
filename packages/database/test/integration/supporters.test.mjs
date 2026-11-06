import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  deleteAccount,
  DEMO_PROFILES,
  publicProfile,
  stopRecognition,
  tipStatusView,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

const ADA_USER = DEMO_PROFILES[0].userId;
const newKey = () => randomBytes(32).toString('base64url');
const sha256 = (text) => createHash('sha256').update(text).digest();

test('repeat supporters: the supporter’s choice', async (t) => {
  const database = await useDatabase(t);
  const quote = (handle = 'ada') =>
    createQuote(database.db, { handle, tipMinor: 200000n, currency: 'NGN' });
  const makePro = (id = ADA) =>
    database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [id]);
  const tip = async (input = {}, handle = 'ada') =>
    createPaymentIntent(database.db, {
      quoteId: (await quote(handle)).quoteId,
      idempotencyKey: randomUUID(),
      recognitionOn: true,
      ...input,
    });
  const rows = async (sql, params = []) =>
    (await database.pool.query(sql, params)).rows;
  // Places a tip as paid with the transition triggers bypassed: this tests the read model only.
  const markPaid = async (tipId) => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        "UPDATE tips SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1",
        [tipId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };

  await t.test(
    "no key: no supporters row, and the fingerprint equals dev's for the same input",
    async () => {
      await database.fresh();
      await makePro();
      const { quoteId } = await quote();
      const { intentId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        payerDisplayLabel: 'Chidi',
        message: 'Thank you',
        noteMayShow: true,
        recognitionOn: true,
      });
      // Dev's expression: quote, label, message, moment, then consent only when given.
      const dev = createHash('sha256')
        .update(JSON.stringify([quoteId, 'Chidi', 'Thank you', null, true]))
        .digest('hex');
      const [stored] = await rows(
        'SELECT request_fingerprint FROM payment_intents WHERE id = $1',
        [intentId],
      );
      assert.equal(stored.request_fingerprint, dev);
      assert.equal(await database.count('supporters'), 0);
      assert.equal(await database.count('tip_supporters'), 0);
    },
  );

  await t.test(
    'a key with a name on a Pro page: one supporter, one tip_supporters row, key stored only as its sha256',
    async () => {
      await database.fresh();
      await makePro();
      const key = newKey();
      const { tipId, intentId } = await tip({
        payerDisplayLabel: '  Chidi  ',
        supporterKey: key,
      });
      const supporters = await rows(
        'SELECT id, profile_id, key_hash, label FROM supporters',
      );
      assert.equal(supporters.length, 1);
      assert.equal(supporters[0].profile_id, ADA);
      assert.equal(supporters[0].label, 'Chidi');
      assert.deepEqual(supporters[0].key_hash, sha256(key));
      const links = await rows(
        'SELECT tip_id, supporter_id FROM tip_supporters',
      );
      assert.deepEqual(links, [
        { tip_id: tipId, supporter_id: supporters[0].id },
      ]);
      // The fingerprint gains the key's hash, never the key.
      const [intent] = await rows(
        'SELECT request_fingerprint FROM payment_intents WHERE id = $1',
        [intentId],
      );
      assert.notEqual(intent.request_fingerprint, key);
      // The raw key is nowhere in any table this tip wrote.
      for (const table of [
        'payment_intents',
        'tips',
        'payment_attempts',
        'status_transitions',
        'supporters',
        'tip_supporters',
      ]) {
        const dump = await rows(
          `SELECT row_to_json(t)::text AS j FROM ${table} t`,
        );
        for (const { j } of dump)
          assert.ok(!j.includes(key), `${table} holds the raw key`);
      }
    },
  );

  await t.test(
    'a key without a name, on a Free page, or with recognitionOn false: nothing stored, the tip is made',
    async () => {
      await database.fresh();
      // Free page.
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: newKey() });
      await makePro();
      // No name, or a name that cleans to nothing.
      await tip({ supporterKey: newKey() });
      await tip({ payerDisplayLabel: ' \u0007 ', supporterKey: newKey() });
      // The switch is off.
      await tip({
        payerDisplayLabel: 'Chidi',
        supporterKey: newKey(),
        recognitionOn: false,
      });
      // Not passed at all: off is the default.
      await createPaymentIntent(database.db, {
        quoteId: (await quote()).quoteId,
        idempotencyKey: randomUUID(),
        payerDisplayLabel: 'Chidi',
        supporterKey: newKey(),
      });
      assert.equal(await database.count('tips'), 5);
      assert.equal(await database.count('supporters'), 0);
      assert.equal(await database.count('tip_supporters'), 0);
    },
  );

  await t.test(
    'the same key twice: one supporter, label and last_at updated, two tip rows',
    async () => {
      await database.fresh();
      await makePro();
      const key = newKey();
      const first = await tip({
        payerDisplayLabel: 'Chidi',
        supporterKey: key,
        now: new Date('2026-11-06T10:00:00Z'),
      });
      const second = await tip({
        payerDisplayLabel: 'Chidi O.',
        supporterKey: key,
        now: new Date('2026-11-06T11:00:00Z'),
      });
      const supporters = await rows(
        'SELECT id, label, first_at, last_at FROM supporters',
      );
      assert.equal(supporters.length, 1);
      assert.equal(supporters[0].label, 'Chidi O.');
      assert.equal(
        supporters[0].first_at.toISOString(),
        '2026-11-06T10:00:00.000Z',
      );
      assert.equal(
        supporters[0].last_at.toISOString(),
        '2026-11-06T11:00:00.000Z',
      );
      const links = await rows(
        'SELECT tip_id FROM tip_supporters WHERE supporter_id = $1 ORDER BY tip_id',
        [supporters[0].id],
      );
      assert.deepEqual(
        links.map((row) => row.tip_id).sort(),
        [first.tipId, second.tipId].sort(),
      );
    },
  );

  await t.test(
    '20 concurrent tips with one new key make one supporter',
    async () => {
      await database.fresh();
      await makePro();
      const key = newKey();
      await Promise.all(
        Array.from({ length: 20 }, () =>
          tip({ payerDisplayLabel: 'Chidi', supporterKey: key }),
        ),
      );
      assert.equal(await database.count('supporters'), 1);
      assert.equal(await database.count('tip_supporters'), 20);
    },
  );

  await t.test(
    'the same key on two recipients: two supporters rows (no link between them)',
    async () => {
      await database.fresh();
      await makePro(ADA);
      await makePro(TOBI);
      const key = newKey();
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: key }, 'ada');
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: key }, 'tobi');
      const supporters = await rows(
        'SELECT profile_id FROM supporters ORDER BY profile_id',
      );
      assert.deepEqual(
        supporters.map((row) => row.profile_id).sort(),
        [ADA, TOBI].sort(),
      );
    },
  );

  await t.test(
    'adding a key to a replayed idempotency key is IDEMPOTENCY_CONFLICT; the same request replays',
    async () => {
      await database.fresh();
      await makePro();
      const { quoteId } = await quote();
      const idempotencyKey = randomUUID();
      const base = {
        quoteId,
        idempotencyKey,
        payerDisplayLabel: 'Chidi',
        recognitionOn: true,
      };
      await createPaymentIntent(database.db, base);
      await assert.rejects(
        createPaymentIntent(database.db, { ...base, supporterKey: newKey() }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      // A key first used with a supporter key: a different key, or none, is refused too.
      const other = await quote();
      const key = newKey();
      const keyed = {
        ...base,
        quoteId: other.quoteId,
        idempotencyKey: randomUUID(),
        supporterKey: key,
      };
      const first = await createPaymentIntent(database.db, keyed);
      await assert.rejects(
        createPaymentIntent(database.db, { ...keyed, supporterKey: newKey() }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      const { supporterKey: _dropped, ...withoutKey } = keyed;
      await assert.rejects(createPaymentIntent(database.db, withoutKey), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      const again = await createPaymentIntent(database.db, keyed);
      assert.equal(again.replayed, true);
      assert.equal(again.tipId, first.tipId);
      assert.equal(await database.count('tip_supporters'), 1);
    },
  );

  await t.test(
    '__testFailAfter tip: no tip, intent, attempt, supporter or tip_supporters row remains',
    async () => {
      await database.fresh();
      await makePro();
      process.env.NODE_ENV = 'test';
      await assert.rejects(
        tip({
          payerDisplayLabel: 'Chidi',
          supporterKey: newKey(),
          __testFailAfter: 'tip',
        }),
      );
      for (const table of [
        'payment_intents',
        'tips',
        'payment_attempts',
        'supporters',
        'tip_supporters',
      ])
        assert.equal(await database.count(table), 0, table);
    },
  );

  await t.test(
    'tip status: recognised only when the paid tip has a supporter row',
    async () => {
      await database.fresh();
      await makePro();
      const kept = await tip({
        payerDisplayLabel: 'Chidi',
        supporterKey: newKey(),
      });
      const plain = await tip({ payerDisplayLabel: 'Chidi' });
      const now = new Date();
      assert.equal(
        (await tipStatusView(database.db, kept.tipId, now)).recognised,
        undefined,
        'not before it is paid',
      );
      await markPaid(kept.tipId);
      await markPaid(plain.tipId);
      assert.equal(
        (await tipStatusView(database.db, kept.tipId, now)).recognised,
        true,
      );
      assert.equal(
        'recognised' in (await tipStatusView(database.db, plain.tipId, now)),
        false,
      );
    },
  );

  await t.test(
    'stop: the supporter row and all its tip links go; the tips and notes stay; again is a no-op',
    async () => {
      await database.fresh();
      await makePro();
      const key = newKey();
      const one = await tip({
        payerDisplayLabel: 'Chidi',
        supporterKey: key,
        message: 'Thank you',
      });
      const two = await tip({ payerDisplayLabel: 'Chidi', supporterKey: key });
      const other = await tip({
        payerDisplayLabel: 'Bisi',
        supporterKey: newKey(),
      });
      await markPaid(one.tipId);
      assert.equal(await stopRecognition(database.db, two.tipId), true);
      assert.equal(await database.count('supporters'), 1);
      assert.deepEqual(await rows('SELECT tip_id FROM tip_supporters'), [
        { tip_id: other.tipId },
      ]);
      assert.equal(await database.count('tips'), 3);
      assert.equal(await database.count('tip_messages'), 1);
      assert.equal(
        'recognised' in
          (await tipStatusView(database.db, one.tipId, new Date())),
        false,
      );
      // Already stopped, or never recognised: nothing to do, still fine.
      assert.equal(await stopRecognition(database.db, one.tipId), false);
      assert.equal(await stopRecognition(database.db, randomUUID()), false);
      // A later tip with the same key starts a new supporter: nothing joins it to the old tips.
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: key });
      assert.equal(await database.count('supporters'), 2);
      assert.equal(await database.count('tip_supporters'), 2);
    },
  );

  await t.test(
    'the public page offers recognition only when Pro and switched on',
    async () => {
      await database.fresh();
      await database.pool.query(
        "UPDATE profiles SET page_state = 'live' WHERE id = $1",
        [ADA],
      );
      const flag = async (options) =>
        (await publicProfile(database.db, 'ada', options))?.recognition;
      assert.equal(await flag({ recognition: true }), undefined, 'Free');
      await makePro();
      assert.equal(await flag({ recognition: true }), true);
      assert.equal(await flag({ recognition: false }), undefined, 'off');
      assert.equal(await flag({}), undefined, 'off unless asked');
    },
  );

  await t.test(
    'deleting the account deletes its supporters and tip_supporters',
    async () => {
      await database.fresh();
      await makePro(ADA);
      await makePro(TOBI);
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: newKey() }, 'ada');
      await tip({ payerDisplayLabel: 'Chidi', supporterKey: newKey() }, 'tobi');
      await deleteAccount(database.db, { userId: ADA_USER, now: new Date() });
      const left = await rows('SELECT profile_id FROM supporters');
      assert.deepEqual(left, [{ profile_id: TOBI }]);
      assert.equal(await database.count('tip_supporters'), 1);
      // The money rows stay.
      assert.equal(await database.count('tips'), 2);
    },
  );
});
