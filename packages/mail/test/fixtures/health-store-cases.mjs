import assert from 'node:assert/strict';

/**
 * The breaker store's rules, run against each store: the in-process one here, and the Redis one
 * (Lua) in packages/database/test/integration/mail-failover.test.mjs, so the two never drift.
 * `makeStore(settings)` may be async; times are plain epoch milliseconds.
 */
export function runHealthStoreCases(test, makeStore, prefix = 'store') {
  const SETTINGS = {
    threshold: 3,
    windowMs: 300_000,
    restMs: 900_000,
    trialCodes: 3,
    realertMs: 6 * 3_600_000,
    probeLeaseMs: 60_000,
  };
  const T = Date.parse('2026-11-23T10:00:00Z');
  const make = () => makeStore(SETTINGS);

  test(`${prefix}: three failures inside the window trip; spread wider they never do`, async () => {
    const store = await make();
    assert.equal(await store.fail('zeptomail', T, 'a'), null);
    assert.equal(await store.fail('zeptomail', T + 200_000, 'b'), null);
    assert.equal(await store.fail('zeptomail', T + 400_000, 'c'), null);
    assert.equal(
      (await store.read(['zeptomail'])).get('zeptomail')?.state ?? 'closed',
      'closed',
    );
    assert.equal(await store.fail('zeptomail', T + 450_000, 'd'), 'tripped');
    const record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'open');
    assert.equal(record.kind, 'send');
    assert.equal(record.until, T + 450_000 + 900_000);
    assert.equal(record.reason, 'd');
    assert.equal(record.trippedAt, T + 450_000);
    // Resting: more failures change nothing.
    assert.equal(await store.fail('zeptomail', T + 460_000, 'e'), null);
  });

  test(`${prefix}: after the rest one probe at a time; success restores, the failures start again`, async () => {
    const store = await make();
    for (let i = 0; i < 3; i++) await store.fail('brevo', T + i, 'x');
    assert.equal(await store.claim('brevo', T + 1000, false), false, 'resting');
    const after = T + 2 + 900_000;
    assert.equal(await store.claim('brevo', after, false), true);
    assert.equal((await store.read(['brevo'])).get('brevo').state, 'trial');
    assert.equal(
      await store.claim('brevo', after + 1, false),
      false,
      'one probe',
    );
    assert.equal(
      await store.claim('brevo', after + 1, true),
      false,
      'a code is no extra probe',
    );
    // A probe that never reported back frees the slot after its lease.
    assert.equal(await store.claim('brevo', after + 60_000, false), true);
    // A codes success does not end a send trip.
    assert.equal(await store.succeed('brevo', after + 60_001, 'codes'), null);
    assert.equal(
      await store.succeed('brevo', after + 60_002, 'send'),
      'recovered',
    );
    const record = (await store.read(['brevo'])).get('brevo');
    assert.equal(record.state, 'closed');
    assert.equal(record.recoveredAt, after + 60_002);
    // The reason stays for ops after recovery.
    assert.equal(record.reason, 'x');
    // Old failures were forgotten: two new ones don't trip.
    await store.fail('brevo', after + 70_000, 'y');
    await store.fail('brevo', after + 70_001, 'y');
    assert.equal((await store.read(['brevo'])).get('brevo').state, 'closed');
    // A success outside a trial changes nothing.
    assert.equal(await store.succeed('brevo', after + 70_002, 'send'), null);
  });

  test(`${prefix}: a failed trial rests again; staff hear "still down" at most every 6 hours`, async () => {
    const store = await make();
    for (let i = 0; i < 3; i++) await store.fail('ses', T, 'x');
    let now = T + 900_000;
    assert.equal(await store.claim('ses', now, false), true);
    assert.equal(
      await store.fail('ses', now, 'http_502'),
      null,
      'within 6 h of the alert',
    );
    let record = (await store.read(['ses'])).get('ses');
    assert.equal(record.state, 'open');
    assert.equal(record.until, now + 900_000);
    assert.equal(record.reason, 'http_502');
    const changes = [];
    for (let i = 0; i < 24; i++) {
      now += 900_000;
      assert.equal(await store.claim('ses', now, false), true);
      const change = await store.fail('ses', now, 'http_500');
      if (change) changes.push(change);
    }
    assert.deepEqual(changes, ['still_down']);
    record = (await store.read(['ses'])).get('ses');
    assert.equal(record.trippedAt, T, 'the first trip time is kept');
  });

  test(`${prefix}: a codes trip rests the provider; only the next three codes are its trial`, async () => {
    const store = await make();
    assert.equal(
      await store.trip(
        'zeptomail',
        T,
        '4 of 6 codes unused in 10 min',
        'codes',
      ),
      'tripped',
    );
    assert.equal(
      await store.trip('zeptomail', T + 1, 'again', 'codes'),
      null,
      'already resting',
    );
    let record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.kind, 'codes');
    assert.equal(record.reason, '4 of 6 codes unused in 10 min');
    const after = T + 900_000;
    assert.equal(
      await store.claim('zeptomail', after, false),
      false,
      'not a code',
    );
    assert.equal(await store.claim('zeptomail', after, true), true);
    record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'trial');
    assert.equal(record.trialStartedAt, after);
    assert.equal(await store.claim('zeptomail', after + 1, true), true);
    assert.equal(await store.claim('zeptomail', after + 2, true), true);
    assert.equal(await store.claim('zeptomail', after + 3, true), false);
    assert.equal(
      (await store.read(['zeptomail'])).get('zeptomail').trialUsed,
      3,
    );
    // A plain send success proves nothing about delivery.
    assert.equal(await store.succeed('zeptomail', after + 4, 'send'), null);
    // Unused trial codes: rest again (a trip during the trial).
    assert.equal(
      await store.trip('zeptomail', after + 5, 'trial codes unused', 'codes'),
      null,
    );
    record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'open');
    assert.equal(record.until, after + 5 + 900_000);
    // The next trial: redeemed codes restore it.
    const later = after + 5 + 900_000;
    assert.equal(await store.claim('zeptomail', later, true), true);
    assert.equal(
      await store.succeed('zeptomail', later + 1, 'codes'),
      'recovered',
    );
    assert.equal(
      (await store.read(['zeptomail'])).get('zeptomail').state,
      'closed',
    );
  });

  test(`${prefix}: after a codes trip, other mail never starts the trial clock`, async () => {
    const store = await make();
    await store.trip('zeptomail', T, 'x', 'codes');
    const after = T + 900_000;
    assert.equal(await store.claim('zeptomail', after, false), false);
    let record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'open', 'still waiting for a code');
    assert.equal(record.trialStartedAt, null);
    assert.equal(await store.claim('zeptomail', after + 60_000, true), true);
    record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'trial');
    assert.equal(record.trialStartedAt, after + 60_000);
  });

  test(`${prefix}: a failed trial send keeps its own reason`, async () => {
    const store = await make();
    for (let i = 0; i < 3; i++)
      await store.fail('ses', T, '3 send failures', 'probe failed');
    assert.equal(await store.claim('ses', T + 900_000, false), true);
    await store.fail(
      'ses',
      T + 900_001,
      '3 send failures',
      'trial send failed (http_500)',
    );
    assert.equal(
      (await store.read(['ses'])).get('ses').reason,
      'trial send failed (http_500)',
    );
  });

  test(`${prefix}: a definite failure during a codes trial rests it as a send failure`, async () => {
    const store = await make();
    await store.trip('brevo', T, 'codes', 'codes');
    assert.equal(await store.claim('brevo', T + 900_000, true), true);
    await store.fail('brevo', T + 900_001, 'timeout');
    const record = (await store.read(['brevo'])).get('brevo');
    assert.equal(record.state, 'open');
    assert.equal(record.kind, 'send');
  });

  test(`${prefix}: staff clear a resting provider by hand; clearing a healthy one does nothing`, async () => {
    const store = await make();
    assert.equal(await store.clear('zeptomail', T), false);
    await store.trip('zeptomail', T, 'x', 'codes');
    assert.equal(await store.clear('zeptomail', T + 5), true);
    const record = (await store.read(['zeptomail'])).get('zeptomail');
    assert.equal(record.state, 'closed');
    assert.equal(record.recoveredAt, T + 5);
    assert.equal(
      await store.claim('zeptomail', T + 6, true),
      false,
      'no trial when healthy',
    );
  });

  test(`${prefix}: providers are separate, and one never seen reads as nothing (healthy)`, async () => {
    const store = await make();
    await store.trip('zeptomail', T, 'x', 'send');
    const records = await store.read(['zeptomail', 'brevo']);
    assert.equal(records.get('zeptomail').state, 'open');
    assert.equal(records.has('brevo'), false);
  });
}
