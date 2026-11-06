import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  businessNotes,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  locationInsights,
  markAttemptInitiated,
  recordProviderEvent,
  noteTipOf,
  setShareAmounts,
} from '../../dist/index.js';
import {
  leaveMember,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B7: what the business sees. The privacy core: every number below 3 is
// "fewer than 3", no naira unless the person shares them, no supporter, message, time or reference.

const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);
// ISO week 2026-W42: Monday 12 October to Sunday 18 October 2026, Lagos.
const WEEK = '2026-W42';

/** Every `Shown` in a response: either 0, or at least 3. 1 and 2 never leave as numbers. */
function shownNumbers(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => shownNumbers(item, found));
  else if (value && typeof value === 'object') {
    if (
      'fewerThan' in value ||
      ('n' in value && Object.keys(value).length === 1)
    )
      found.push(value);
    else Object.values(value).forEach((item) => shownNumbers(item, found));
  }
  return found;
}

test('what the business sees', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);

  /** A live page of its own for a person who isn't one of the demo pages. */
  const seedPage = async (handle, displayName) => {
    const userId = randomUUID();
    const profileId = randomUUID();
    await q(`INSERT INTO users (id, phone_e164) VALUES ($1, $2)`, [
      userId,
      `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    ]);
    await q(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, visibility, status, page_state)
       VALUES ($1, $2, $3, $3, $4, 'public', 'active', 'live')`,
      [profileId, userId, handle, displayName],
    );
    return { userId, profileId, handle };
  };

  /** A tip paid at `at`, made at a business through `memberId`. */
  const paid = async (
    handle,
    memberId,
    at,
    { label, message, tipMinor = 200000n } = {},
  ) => {
    const before = new Date(at.getTime() - 60_000);
    const quote = await createQuote(db, {
      handle,
      tipMinor,
      currency: 'NGN',
      now: before,
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      payerDisplayLabel: label,
      message,
      businessMemberId: memberId,
      now: before,
    });
    const reference = `mock_pay_${randomUUID()}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'mock',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: tipMinor,
      currency: 'NGN',
      providerFeeMinor: quote.breakdown.providerFeeMinor,
      signatureVerified: true,
      payload: {},
      now: at,
    });
    return {
      tipId: intent.tipId,
      reference,
      net: quote.breakdown.recipientNetMinor,
    };
  };
  const note = async (tip, memberId, { tags = ['friendly'], body } = {}) =>
    q(
      `INSERT INTO business_notes (tip_id, member_id, tags, body) VALUES ($1, $2, $3, $4)`,
      [tip.tipId, memberId, tags, body ?? null],
    );
  const report = (tip, outcome) =>
    q(
      `INSERT INTO business_note_flags (tip_id, reported_at, reported_by, reason, reviewed_at, outcome)
       VALUES ($1, now(), 'member', 'abusive', $2, $3)`,
      [tip.tipId, outcome ? new Date() : null, outcome ?? null],
    );

  /** A verified business with VI and Ikoyi, owned by Ada; Tobi and two more pages work at VI. */
  const setUp = async () => {
    await database.fresh();
    const business = await seedBusiness(database, {
      locations: [
        { slug: 'vi', name: 'Victoria Island' },
        { slug: 'ikoyi', name: 'Ikoyi' },
      ],
    });
    const [vi, ikoyi] = business.locations;
    const chioma = await seedPage('chioma', 'Chioma Eze');
    const emeka = await seedPage('emeka', 'Emeka Obi');
    const member = async (profileId, shownName, locationId = vi.id) =>
      (await seedMember(database, { locationId, profileId, shownName }))
        .memberId;
    return {
      businessId: business.businessId,
      vi: vi.id,
      ikoyi: ikoyi.id,
      chioma,
      emeka,
      tobiMember: await member(TOBI.id, 'Tobi'),
      adaMember: await member(ADA.id, 'Ada'),
      chiomaMember: await member(chioma.profileId, 'Chioma'),
      emekaMember: await member(emeka.profileId, 'Emeka'),
    };
  };
  const insights = (s, week = WEEK, locationId = s.vi, user = ADA.userId) =>
    locationInsights(db, user, s.businessId, { locationId, week });
  const notes = (s, week = WEEK, locationId = s.vi, user = ADA.userId) =>
    businessNotes(db, user, s.businessId, { locationId, week });
  const row = (result, shownName) =>
    result.people.find((person) => person.shownName === shownName);

  await t.test(
    'counts per person; 1 and 2 read as fewer than 3, 0 as 0',
    async () => {
      const s = await setUp();
      const tobiTips = [];
      for (const day of ['12', '13', '14'])
        tobiTips.push(
          await paid('tobi', s.tobiMember, lagos(`2026-10-${day}T12:00:00`)),
        );
      await paid('ada', s.adaMember, lagos('2026-10-13T12:00:00'));
      await paid('ada', s.adaMember, lagos('2026-10-14T12:00:00'));
      const chiomaTip = await paid(
        'chioma',
        s.chiomaMember,
        lagos('2026-10-14T13:00:00'),
      );
      await note(tobiTips[0], s.tobiMember, { tags: ['friendly', 'fast'] });
      await note(tobiTips[1], s.tobiMember);
      await note(tobiTips[2], s.tobiMember);
      await note(chiomaTip, s.chiomaMember, { tags: ['made_my_day'] });

      const result = await insights(s);
      assert.equal(result.week, WEEK);
      assert.equal(result.locationId, s.vi);
      assert.deepEqual(result.tips, { n: 6 });
      assert.deepEqual(
        result.people.map((person) => person.shownName),
        // Three or more first; then everyone under 3 together, by name, so the order never ranks
        // two people whose counts the business may not see.
        ['Tobi', 'Ada', 'Chioma'],
      );
      assert.deepEqual(row(result, 'Tobi'), {
        memberId: s.tobiMember,
        shownName: 'Tobi',
        left: false,
        tips: { n: 3 },
        notes: { n: 3 },
        tags: {
          friendly: { n: 3 },
          fast: { fewerThan: 3 },
          extra_mile: { n: 0 },
          great_advice: { n: 0 },
          made_my_day: { n: 0 },
        },
      });
      assert.deepEqual(row(result, 'Ada').tips, { fewerThan: 3 });
      assert.deepEqual(row(result, 'Ada').notes, { n: 0 });
      assert.deepEqual(row(result, 'Chioma').tips, { fewerThan: 3 });
      assert.deepEqual(row(result, 'Chioma').notes, { fewerThan: 3 });
      assert.deepEqual(row(result, 'Chioma').tags.made_my_day, {
        fewerThan: 3,
      });
      // Emeka works there but had no tips this week: no row.
      assert.equal(row(result, 'Emeka'), undefined);
      for (const shown of shownNumbers(result))
        assert.ok(
          'fewerThan' in shown || shown.n === 0 || shown.n >= 3,
          `a group under 3 left as a number: ${JSON.stringify(shown)}`,
        );

      // A location with no tips this week: 0, no people.
      const empty = await insights(s, WEEK, s.ikoyi);
      assert.deepEqual(empty.tips, { n: 0 });
      assert.deepEqual(empty.people, []);
      assert.equal(empty.busiest, undefined);
      assert.equal(empty.topTag, undefined);
    },
  );

  await t.test(
    'amounts appear only for a person who shares them and has at least 3 tips',
    async () => {
      const s = await setUp();
      const nets = [];
      for (const day of ['12', '13', '14'])
        nets.push(
          (
            await paid('tobi', s.tobiMember, lagos(`2026-10-${day}T12:00:00`), {
              tipMinor: 300000n,
            })
          ).net,
        );
      for (const day of ['12', '13', '14'])
        await paid('chioma', s.chiomaMember, lagos(`2026-10-${day}T15:00:00`));
      await paid('ada', s.adaMember, lagos('2026-10-13T12:00:00'));
      await paid('ada', s.adaMember, lagos('2026-10-14T12:00:00'));

      // By default nobody shares: no amount anywhere in the response.
      const before = await insights(s);
      for (const person of before.people)
        assert.equal(person.amountMinor, undefined, person.shownName);
      assert.doesNotMatch(JSON.stringify(before), /amount/i);

      // Tobi (3 tips) and Ada (2 tips) turn sharing on; Chioma (3 tips) doesn't.
      const shared = await setShareAmounts(db, TOBI.userId, s.tobiMember, true);
      assert.equal(shared.shareAmounts, true);
      assert.equal(shared.memberId, s.tobiMember);
      assert.equal(
        shared.staffCodePath,
        `/b/${(await q(`SELECT slug FROM businesses`))[0].slug}/vi/tobi`,
      );
      await setShareAmounts(db, ADA.userId, s.adaMember, true);
      const after = await insights(s);
      const total = nets.reduce((sum, net) => sum + net, 0n);
      // The net of each tip: the same figure the person's own Tips list shows.
      assert.equal(row(after, 'Tobi').amountMinor, total.toString());
      assert.equal(row(after, 'Ada').amountMinor, undefined);
      assert.equal(row(after, 'Chioma').amountMinor, undefined);

      // Off again: gone at once.
      const off = await setShareAmounts(db, TOBI.userId, s.tobiMember, false);
      assert.equal(off.shareAmounts, false);
      assert.equal(row(await insights(s), 'Tobi').amountMinor, undefined);

      // Only the person themselves can choose: someone else's membership is not found.
      await assert.rejects(
        setShareAmounts(db, ADA.userId, s.tobiMember, true),
        (error) => error.code === 'NO_MEMBERSHIP',
      );
      // A membership that ended can't be changed either.
      await leaveMember(database, s.chiomaMember);
      await assert.rejects(
        setShareAmounts(db, s.chioma.userId, s.chiomaMember, true),
        (error) => error.code === 'NO_MEMBERSHIP',
      );
    },
  );

  await t.test(
    'busiest hours and top tag only from groups of 3 or more',
    async () => {
      const s = await setUp();
      // Two tips on Friday 16 Oct around 8 pm, one on Wednesday: no window has 3.
      const friday = [
        await paid('tobi', s.tobiMember, lagos('2026-10-16T20:10:00')),
        await paid('ada', s.adaMember, lagos('2026-10-16T20:50:00')),
      ];
      const wednesday = await paid(
        'chioma',
        s.chiomaMember,
        lagos('2026-10-14T09:00:00'),
      );
      await note(friday[0], s.tobiMember, { tags: ['friendly'] });
      await note(friday[1], s.adaMember, { tags: ['friendly'] });
      let result = await insights(s);
      assert.equal(result.busiest, undefined);
      // Two visible notes: no top tag.
      assert.equal(result.topTag, undefined);

      // A third on Friday at 9:40 pm: the 8–10 pm window has 3.
      friday.push(
        await paid('chioma', s.chiomaMember, lagos('2026-10-16T21:40:00')),
      );
      await note(friday[2], s.chiomaMember, { tags: ['fast'] });
      await note(wednesday, s.chiomaMember, { tags: ['fast', 'friendly'] });
      result = await insights(s);
      // Day 5 is Friday (0 is Sunday, as JavaScript's getDay); hours are Lagos time.
      assert.deepEqual(result.busiest, { day: 5, fromHour: 20, toHour: 22 });
      // Four visible notes, three of them say Friendly.
      assert.deepEqual(result.topTag, { tag: 'friendly', percent: 75 });

      // Three notes, but the most-used tag is on only 1 of them: a share of under 3 isn't shown.
      const t2 = await setUp();
      const spread = [
        await paid('tobi', t2.tobiMember, lagos('2026-10-12T10:00:00')),
        await paid('ada', t2.adaMember, lagos('2026-10-13T10:00:00')),
        await paid('chioma', t2.chiomaMember, lagos('2026-10-14T10:00:00')),
      ];
      await note(spread[0], t2.tobiMember, { tags: ['friendly'] });
      await note(spread[1], t2.adaMember, { tags: ['fast'] });
      await note(spread[2], t2.chiomaMember, { tags: ['made_my_day'] });
      assert.equal((await insights(t2)).topTag, undefined);
    },
  );

  await t.test(
    'a person who left: their tips count in the location total; no row, no name, no notes',
    async () => {
      const s = await setUp();
      const chiomaTips = [];
      for (const day of ['12', '13', '14'])
        chiomaTips.push(
          await paid(
            'chioma',
            s.chiomaMember,
            lagos(`2026-10-${day}T12:00:00`),
          ),
        );
      for (const tip of chiomaTips)
        await note(tip, s.chiomaMember, { body: 'Chioma was lovely' });
      for (const day of ['12', '13', '14'])
        await paid('tobi', s.tobiMember, lagos(`2026-10-${day}T18:00:00`));
      await setShareAmounts(db, s.chioma.userId, s.chiomaMember, true);
      await leaveMember(database, s.chiomaMember);

      const result = await insights(s);
      assert.deepEqual(result.tips, { n: 6 });
      assert.deepEqual(
        result.people.map((person) => person.shownName),
        ['Tobi'],
      );
      const json = JSON.stringify([result, await notes(s)]);
      assert.doesNotMatch(json, /Chioma/);
      assert.doesNotMatch(json, new RegExp(s.chiomaMember));
      assert.deepEqual(await notes(s), []);
      // Their notes no longer feed the top tag either.
      assert.equal(result.topTag, undefined);
    },
  );

  await t.test(
    'reported and removed notes are not shown; restored are',
    async () => {
      const s = await setUp();
      const tips = [];
      for (const [day, hour] of [
        ['12', '10'],
        ['13', '11'],
        ['14', '12'],
        ['15', '13'],
      ])
        tips.push(
          await paid(
            'tobi',
            s.tobiMember,
            lagos(`2026-10-${day}T${hour}:00:00`),
          ),
        );
      await note(tips[0], s.tobiMember, { body: 'Shown as written' });
      await note(tips[1], s.tobiMember, { body: 'Reported, waiting' });
      await note(tips[2], s.tobiMember, { body: 'Reported, removed' });
      await note(tips[3], s.tobiMember, { body: 'Reported, restored' });
      await report(tips[1]);
      await report(tips[2], 'removed');
      await report(tips[3], 'restored');

      const list = await notes(s);
      assert.deepEqual(
        list.map((entry) => entry.body),
        // Newest date first.
        ['Reported, restored', 'Shown as written'],
      );
      assert.deepEqual(list[1], {
        tipId: list[1].tipId,
        shownName: 'Tobi',
        date: '2026-10-12',
        tags: ['friendly'],
        body: 'Shown as written',
        reported: false,
      });
      // Hidden notes don't count anywhere either.
      assert.deepEqual(row(await insights(s), 'Tobi').notes, { fewerThan: 3 });
    },
  );

  await t.test(
    'no response field ever carries payer_display_label, a tip message, a time, an amount of a single tip or a reference',
    async () => {
      const s = await setUp();
      const tips = [];
      for (const day of ['12', '13', '14'])
        tips.push(
          await paid('tobi', s.tobiMember, lagos(`2026-10-${day}T20:14:00`), {
            label: 'Chioma Secretname',
            message: 'secret private words',
            tipMinor: 345600n,
          }),
        );
      for (const tip of tips)
        await note(tip, s.tobiMember, { body: 'Kind and quick' });
      const json = JSON.stringify([await insights(s), await notes(s)]);
      assert.doesNotMatch(json, /Secretname/);
      assert.doesNotMatch(json, /secret private words/);
      // No times: no "T20:14", no "20:14", no ISO instant.
      assert.doesNotMatch(json, /\d{2}:\d{2}/);
      assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}T/);
      // No single tip's amount, gross or net, and no total either (nobody shares).
      assert.doesNotMatch(json, /345600/);
      for (const tip of tips) {
        assert.doesNotMatch(json, new RegExp(tip.net.toString()));
        assert.doesNotMatch(json, new RegExp(tip.reference));
        // A tip's id is a time-ordered UUID (v7): its first 48 bits are the moment the tip was
        // started, so it would give away the time. The business gets an unrelated reference.
        assert.doesNotMatch(json, new RegExp(tip.tipId));
        assert.doesNotMatch(json, new RegExp(tip.tipId.slice(0, 13)));
      }
      const list = await notes(s);
      assert.equal(list.length, 3);
      assert.equal(new Set(list.map((entry) => entry.tipId)).size, 3);
      for (const entry of list)
        assert.deepEqual(Object.keys(entry).sort(), [
          'body',
          'date',
          'reported',
          'shownName',
          'tags',
          'tipId',
        ]);
    },
  );

  await t.test(
    'a note reference leads back to its tip only within its own business',
    async () => {
      const s = await setUp();
      const tip = await paid(
        'tobi',
        s.tobiMember,
        lagos('2026-10-14T12:00:00'),
      );
      await note(tip, s.tobiMember);
      const [shown] = await notes(s);
      assert.equal(await noteTipOf(db, s.businessId, shown.tipId), tip.tipId);
      const other = await seedBusiness(database, { owner: s.chioma.userId });
      assert.equal(await noteTipOf(db, other.businessId, shown.tipId), null);
      assert.equal(await noteTipOf(db, s.businessId, tip.tipId), null);
      assert.equal(await noteTipOf(db, s.businessId, 'not-a-ref'), null);
    },
  );

  await t.test('the week boundary is Monday 00:00 Lagos', async () => {
    const s = await setUp();
    // Sunday 18 Oct 23:59 Lagos is 22:59 UTC: still W42.
    const sunday = await paid(
      'tobi',
      s.tobiMember,
      lagos('2026-10-18T23:59:00'),
    );
    // Monday 19 Oct 00:30 Lagos is Sunday 23:30 UTC: W43, dated the 19th.
    const monday = await paid(
      'tobi',
      s.tobiMember,
      lagos('2026-10-19T00:30:00'),
    );
    await note(sunday, s.tobiMember);
    await note(monday, s.tobiMember);
    assert.deepEqual((await insights(s, '2026-W42')).tips, { fewerThan: 3 });
    assert.deepEqual(
      (await notes(s, '2026-W42')).map((entry) => entry.date),
      ['2026-10-18'],
    );
    assert.deepEqual(
      (await notes(s, '2026-W43')).map((entry) => entry.date),
      ['2026-10-19'],
    );
    // A week that doesn't exist is bad input.
    await assert.rejects(
      insights(s, '2026-W54'),
      (error) => error.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      notes(s, '2026-W00'),
      (error) => error.code === 'INVALID_INPUT',
    );
  });

  await t.test(
    'rehearsal pages are left out, as on every dashboard',
    async () => {
      const s = await setUp();
      for (const day of ['12', '13', '14'])
        await paid('emeka', s.emekaMember, lagos(`2026-10-${day}T12:00:00`));
      await q(`UPDATE profiles SET rehearsal_run_id = $2 WHERE id = $1`, [
        s.emeka.profileId,
        randomUUID(),
      ]);
      const result = await insights(s);
      assert.deepEqual(result.tips, { n: 0 });
      assert.deepEqual(result.people, []);
    },
  );

  await t.test('a location manager of VI gets 404 for Ikoyi', async () => {
    const s = await setUp();
    await seedManager(database, {
      businessId: s.businessId,
      userId: TOBI.userId,
      locationId: s.vi,
    });
    // Their own location: fine.
    assert.deepEqual((await insights(s, WEEK, s.vi, TOBI.userId)).tips, {
      n: 0,
    });
    for (const read of [insights, notes]) {
      await assert.rejects(
        read(s, WEEK, s.ikoyi, TOBI.userId),
        (error) => error.code === 'NOT_A_MANAGER',
      );
      // Someone who doesn't manage the business at all, and another business's location.
      await assert.rejects(
        read(s, WEEK, s.vi, s.emeka.userId),
        (error) => error.code === 'NOT_A_MANAGER',
      );
      const other = await seedBusiness(database, { owner: s.chioma.userId });
      await assert.rejects(
        read(s, WEEK, other.locations[0].id),
        (error) => error.code === 'NOT_A_MANAGER',
      );
    }
  });
});
