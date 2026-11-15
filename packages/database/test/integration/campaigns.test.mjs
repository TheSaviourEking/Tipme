import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  campaignDetail,
  createCampaign,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  listCampaigns,
  markAttemptInitiated,
  recordClientEvent,
  recordProviderEvent,
  renameCampaign,
  rollupAnalytics,
  stopCampaign,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Campaign Studio (ProCampaigns board; owner default: Pro 20 running, Free 1). Counts only.
const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

async function paidTip(db, { campaign, at, tipMinor = 300000n, replayKey }) {
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor,
    currency: 'NGN',
    now: new Date(at.getTime() - 60_000),
  });
  const key = replayKey ?? randomUUID();
  const input = {
    quoteId: quote.quoteId,
    idempotencyKey: key,
    now: new Date(at.getTime() - 60_000),
    ...(campaign ? { campaign } : {}),
  };
  const intent = await createPaymentIntent(db, input);
  // The same request again (a retried tap) replays the same tip: still counted once.
  const replay = await createPaymentIntent(db, input);
  assert.equal(replay.tipId, intent.tipId);
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
  return { ...intent, net: BigInt(quote.breakdown.recipientNetMinor) };
}

const visit = (db, { campaign, now, flowId = randomUUID() }) =>
  recordClientEvent(db, {
    event: {
      name: 'profile_viewed',
      flowId,
      surface: 'profile',
      channel: 'link',
      handle: 'ada',
      ...(campaign ? { campaign } : {}),
    },
    device: 'mobile',
    now,
  });

test('campaign limits: Free 1 running, Pro 20; stopping one frees a place', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const now = lagos('2026-11-08T12:00:00');
  const first = await createCampaign(db, ADA.id, {
    name: 'Saturday gig',
    slug: 'saturday-gig',
    now,
  });
  await assert.rejects(
    createCampaign(db, ADA.id, { name: 'Second', slug: 'second', now }),
    { code: 'CAMPAIGN_LIMIT' },
  );
  await stopCampaign(db, ADA.id, first.id, now);
  await createCampaign(db, ADA.id, { name: 'Second', slug: 'second', now });

  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  for (let i = 2; i <= 20; i++)
    await createCampaign(db, ADA.id, { name: `C${i}`, slug: `c-${i}`, now });
  await assert.rejects(
    createCampaign(db, ADA.id, { name: 'Twenty-one', slug: 'c-21', now }),
    { code: 'CAMPAIGN_LIMIT' },
  );
  const list = await listCampaigns(db, ADA.id, now);
  assert.equal(list.limit, 20);
  assert.equal(list.used, 20);
  assert.equal(list.campaigns.length, 21);
});

test('link endings: taken, TipMe words and other people’s handles are refused', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  const now = new Date();
  await createCampaign(db, ADA.id, { name: 'IG', slug: 'ig', now });
  await assert.rejects(
    createCampaign(db, ADA.id, { name: 'IG again', slug: 'ig', now }),
    { code: 'CAMPAIGN_SLUG_TAKEN' },
  );
  for (const slug of ['settings', 'share-card', TOBI.handle])
    await assert.rejects(
      createCampaign(db, ADA.id, { name: 'X', slug, now }),
      { code: 'CAMPAIGN_SLUG_UNAVAILABLE' },
      slug,
    );
  // Another page may use the same ending for its own campaign.
  await createCampaign(db, TOBI.id, { name: 'IG', slug: 'ig', now });
});

test('a tip via a campaign link counts once to that campaign; visits and the 3-tip floor', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  const made = lagos('2026-11-01T09:00:00');
  const single = await createCampaign(db, ADA.id, {
    name: 'New single',
    slug: 'new-single',
    now: made,
  });
  const yt = await createCampaign(db, ADA.id, {
    name: 'YouTube',
    slug: 'yt',
    now: made,
  });

  let singleNet = 0n;
  for (const day of ['02', '03', '04'])
    singleNet += (
      await paidTip(db, {
        campaign: 'new-single',
        at: lagos(`2026-11-${day}T12:00:00`),
      })
    ).net;
  const ytTip = await paidTip(db, {
    campaign: 'yt',
    at: lagos('2026-11-05T12:00:00'),
  });
  const plain = await paidTip(db, { at: lagos('2026-11-05T13:00:00') });
  // An ending this page has no campaign for: the tip goes ahead, just not attributed.
  const unknown = await paidTip(db, {
    campaign: 'nope',
    at: lagos('2026-11-05T14:00:00'),
  });
  const { rows } = await database.pool.query(
    'SELECT tip_id, campaign_id FROM tip_campaigns ORDER BY tip_id',
  );
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.campaign_id === single.id).length, 3);
  assert.ok(rows.some((r) => r.tip_id === ytTip.tipId));
  assert.ok(
    !rows.some((r) => r.tip_id === plain.tipId || r.tip_id === unknown.tipId),
  );

  // Visits: one per tab; a second view in the same tab is the same visit.
  const flow = randomUUID();
  const now = lagos('2026-11-08T12:00:00');
  await visit(db, { campaign: 'new-single', now, flowId: flow });
  await visit(db, { campaign: 'new-single', now, flowId: flow });
  await visit(db, { campaign: 'new-single', now });
  await visit(db, { campaign: 'yt', now });
  await visit(db, { now });
  // Older visits come from the daily totals once rolled up and their raw rows are gone.
  await visit(db, {
    campaign: 'new-single',
    now: lagos('2026-11-01T10:00:00'),
  });
  await rollupAnalytics(db, { date: '2026-11-01' });
  await database.pool.query(
    "DELETE FROM analytics_events WHERE at_minute < '2026-11-01T23:00:00Z'",
  );

  const list = await listCampaigns(db, ADA.id, now);
  const row = (id) => list.campaigns.find((c) => c.id === id);
  assert.deepEqual(
    {
      visits: row(single.id).visits,
      tips: row(single.id).tips,
      received: row(single.id).receivedNetMinor,
    },
    { visits: 3, tips: 3, received: singleNet.toString() },
  );
  // One tip: "Fewer than 3", with the amount hidden.
  assert.deepEqual(
    [row(yt.id).visits, row(yt.id).tips, row(yt.id).receivedNetMinor],
    [1, null, null],
  );
  // The plain page link: 2 tips (plain + unknown ending) → hidden; 1 visit.
  assert.deepEqual(list.pageLink, {
    visits: 1,
    tips: null,
    receivedNetMinor: null,
  });

  const detail = await campaignDetail(db, ADA.id, single.id, now);
  assert.equal(detail.slug, 'new-single');
  assert.equal(detail.handle, 'ada');
  assert.equal(detail.tips, 3);
  // Mon 26 Oct (made on Sun 1 Nov) and Mon 2 Nov: the week of 2 Nov holds all 3.
  assert.deepEqual(
    detail.weeks.map((w) => [w.from, w.tips]),
    [
      ['2026-10-26', 0],
      ['2026-11-02', 3],
    ],
  );
  // Another page's campaign is not reachable.
  assert.equal(await campaignDetail(db, TOBI.id, single.id, now), null);

  await renameCampaign(db, ADA.id, single.id, 'Single, out now');
  // A stopped campaign keeps its results, and its ending no longer attributes new tips.
  await stopCampaign(db, ADA.id, single.id, now);
  const after = await paidTip(db, {
    campaign: 'new-single',
    at: lagos('2026-11-08T13:00:00'),
  });
  const attributed = await database.pool.query(
    'SELECT 1 FROM tip_campaigns WHERE tip_id = $1',
    [after.tipId],
  );
  assert.equal(attributed.rows.length, 0);
  const stopped = await campaignDetail(db, ADA.id, single.id, now);
  assert.equal(stopped.name, 'Single, out now');
  assert.ok(stopped.stoppedAt);
  assert.equal(stopped.tips, 3);
});
