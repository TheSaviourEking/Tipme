import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  tipStatusView,
  writeBusinessNote,
} from '../../dist/index.js';
import { seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B5 Task 16: after paying, the supporter may leave one kind note about
// the person, once, within 7 days. It never touches the tip itself.

const DAY = 86_400_000;

/** A tip to Ada, at a business when `memberId` is given, placed as paid `paidDaysAgo` ago. */
async function tipToAda(database, { memberId, paid = true, paidDaysAgo = 0 }) {
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { tipId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
    message: 'private words for Ada',
    ...(memberId ? { businessMemberId: memberId } : {}),
  });
  if (paid) {
    // The read model only: the transition triggers are bypassed to place the paid state.
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `UPDATE tips SET status = 'SUCCEEDED', completed_at = $2 WHERE id = $1`,
        [tipId, new Date(Date.now() - paidDaysAgo * DAY)],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
  return tipId;
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.code };
  }
  return null;
};

test('business notes', async (t) => {
  const database = await useDatabase(t);
  let memberId;
  const fresh = async () => {
    await database.fresh();
    const { locations } = await seedBusiness(database);
    ({ memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: ADA,
    }));
  };

  await t.test(
    'a paid business tip takes one note with tags and text; a second is NOTE_NOT_OPEN',
    async () => {
      await fresh();
      const tipId = await tipToAda(database, { memberId });
      const before = (
        await database.pool.query(
          'SELECT status, gross_minor::text AS gross, profile_id FROM tips WHERE id = $1',
          [tipId],
        )
      ).rows[0];
      await writeBusinessNote(database.db, tipId, {
        tags: ['friendly', 'extra_mile'],
        body: 'He fixed our order in five minutes.',
      });
      const { rows } = await database.pool.query(
        'SELECT member_id, tags, body FROM business_notes WHERE tip_id = $1',
        [tipId],
      );
      assert.deepEqual(rows, [
        {
          member_id: memberId,
          tags: ['friendly', 'extra_mile'],
          body: 'He fixed our order in five minutes.',
        },
      ]);
      assert.deepEqual(
        await refusal(
          writeBusinessNote(database.db, tipId, { tags: ['fast'] }),
        ),
        { code: 'NOTE_NOT_OPEN' },
      );
      // The tip itself is exactly as it was.
      const after = (
        await database.pool.query(
          'SELECT status, gross_minor::text AS gross, profile_id FROM tips WHERE id = $1',
          [tipId],
        )
      ).rows[0];
      assert.deepEqual(after, before);
      // The private tip message is never copied into the note.
      assert.doesNotMatch(JSON.stringify(rows), /private words/);
    },
  );

  await t.test('tags alone, or text alone, are each a note', async () => {
    await fresh();
    const tagsOnly = await tipToAda(database, { memberId });
    const textOnly = await tipToAda(database, { memberId });
    await writeBusinessNote(database.db, tagsOnly, { tags: ['made_my_day'] });
    await writeBusinessNote(database.db, textOnly, {
      tags: [],
      body: 'Kind and calm.',
    });
    assert.equal(await database.count('business_notes'), 2);
  });

  await t.test(
    'a plain tip, an unpaid tip, a tip after 7 days: NOTE_NOT_OPEN',
    async () => {
      await fresh();
      const plain = await tipToAda(database, {});
      const unpaid = await tipToAda(database, { memberId, paid: false });
      const late = await tipToAda(database, { memberId, paidDaysAgo: 8 });
      const justInTime = await tipToAda(database, {
        memberId,
        paidDaysAgo: 6.9,
      });
      for (const tipId of [plain, unpaid, late, randomUUID(), 'not-a-uuid'])
        assert.deepEqual(
          await refusal(
            writeBusinessNote(database.db, tipId, { tags: ['fast'] }),
          ),
          { code: 'NOTE_NOT_OPEN' },
          tipId,
        );
      await writeBusinessNote(database.db, justInTime, { tags: ['fast'] });
      assert.equal(await database.count('business_notes'), 1);
    },
  );

  await t.test(
    'text with a link or a phone number is refused (NOTE_TEXT_REFUSED: the API answers fields ["body"])',
    async () => {
      await fresh();
      const tipId = await tipToAda(database, { memberId });
      for (const body of [
        'Find me at example.com/tobi',
        'Call 0803 123 4567 any time',
        'Write to tobi@example.com',
        'https://example.com',
      ])
        assert.deepEqual(
          await refusal(
            writeBusinessNote(database.db, tipId, { tags: [], body }),
          ),
          { code: 'NOTE_TEXT_REFUSED' },
          body,
        );
      // Nothing to send, or more than 280 code points, is refused too.
      assert.equal(
        (await refusal(writeBusinessNote(database.db, tipId, { tags: [] })))
          .code,
        'NOTE_TEXT_REFUSED',
      );
      assert.equal(
        (
          await refusal(
            writeBusinessNote(database.db, tipId, {
              tags: [],
              body: '🙂'.repeat(281),
            }),
          )
        ).code,
        'NOTE_TEXT_REFUSED',
      );
      assert.equal(await database.count('business_notes'), 0);
      // 280 emoji is 280 code points: allowed.
      await writeBusinessNote(database.db, tipId, {
        tags: [],
        body: '🙂'.repeat(280),
      });
      assert.equal(await database.count('business_notes'), 1);
    },
  );

  await t.test('two notes written at once: exactly one lands', async () => {
    await fresh();
    const tipId = await tipToAda(database, { memberId });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        writeBusinessNote(database.db, tipId, { tags: ['fast'] }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((r) => r.status === 'rejected'))
      assert.equal(r.reason.code, 'NOTE_NOT_OPEN');
    assert.equal(await database.count('business_notes'), 1);
  });

  await t.test(
    'the receipt view says a note is open, then written; never for a plain or late tip',
    async () => {
      await fresh();
      const tipId = await tipToAda(database, { memberId });
      const now = new Date();
      assert.deepEqual(
        (await tipStatusView(database.db, tipId, now)).businessNote,
        {
          business: 'The Yellow Chilli',
          person: 'Tobi',
          written: false,
          open: true,
        },
      );
      await writeBusinessNote(database.db, tipId, { tags: ['fast'] });
      assert.deepEqual(
        (await tipStatusView(database.db, tipId, now)).businessNote,
        {
          business: 'The Yellow Chilli',
          person: 'Tobi',
          written: true,
          open: false,
        },
      );
      const late = await tipToAda(database, { memberId, paidDaysAgo: 8 });
      assert.deepEqual(
        (await tipStatusView(database.db, late, now)).businessNote,
        {
          business: 'The Yellow Chilli',
          person: 'Tobi',
          written: false,
          open: false,
        },
      );
      const plain = await tipToAda(database, {});
      assert.equal(
        'businessNote' in (await tipStatusView(database.db, plain, now)),
        false,
      );
      const unpaid = await tipToAda(database, { memberId, paid: false });
      assert.equal(
        'businessNote' in (await tipStatusView(database.db, unpaid, now)),
        false,
      );
    },
  );
});
