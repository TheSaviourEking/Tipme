import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  DisputeEvidenceRefusedError,
  UncertainProviderOutcomeError,
  createBachsProvider,
  disputeAsReversal,
} from '../dist/index.js';

/*
 * You collect (plan Task 5, R1): a dispute on a tip charged on TipMe's own account is TipMe's, so it
 * is modelled (amount, status, deadline, fee) instead of only flagged. A connected account's dispute
 * keeps today's reversal, byte for byte. The Global Constraints forbid any call to the partner here:
 * every body comes from test/fixtures/collect/dispute-*.json, each built from the partner's dispute
 * docs (`_source` names the page). The sandbox may not raise disputes, so none is recorded.
 */
const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
const SECRET = 'current-secret-0123456789';
const SANDBOX_HOST = 'sandbox-api.bachs.io';
const DISPUTE = 'dsp_1a2b3c4d5e';
const CHARGE = 'ch_9f4c1d2e7b6a4f8e9c0d1a2b3c4d5e6f';
const NOW = new Date('2026-11-19T12:01:00Z');

function fixture(name) {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/collect/${name}.json`, import.meta.url)),
  );
  assert.equal(typeof raw._source, 'string', `${name} names its source`);
  assert.match(
    raw._source,
    /https:\/\/docs\.bachs\.io\//,
    `${name} cites a doc`,
  );
  return raw;
}

function body(name) {
  const { _source, _status, ...rest } = fixture(name);
  return rest;
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error('a real fetch was attempted');
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fake(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: [SECRET],
    platformOrganizationId: PLATFORM_ORG,
    fetchImpl: async (url, init) => {
      assert.equal(url.host, SANDBOX_HOST);
      assert.equal(url.protocol, 'https:');
      const call = {
        method: init.method,
        path: `${url.pathname}${url.search}`,
        headers: init.headers,
        rawBody: init.body,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const next = queue ? queue.shift() : answers(call);
      if (next === undefined) throw new Error('unexpected request');
      const resolved = typeof next === 'function' ? next(call) : next;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
  });
  return { provider, calls };
}

const quiet = () =>
  fake(() => {
    throw new Error('no request expected');
  }).provider;

function signed(provider, event, { secret = SECRET, at = NOW } = {}) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  return provider.verifyWebhook(
    rawBody,
    { 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` },
    NOW,
  );
}

const withData = (name, data) => {
  const event = body(name);
  return { ...event, data: { ...event.data, ...data } };
};

// What the adapter returned for these exact bodies before this change (recorded from the code at
// 167d7ee9): every dispute was a reversal carrying ids only.
const BEFORE = {
  connected: {
    kind: 'reversal',
    eventId: 'evt_1a2b3c4d5e6f7g8h',
    eventType: 'dispute.created',
    accountReference: 'acct_7KpQ2mNv4XbR9dLc',
    providerReference: null,
    operationReference: null,
    partnerReversalId: `dispute.${DISPUTE}`,
    disputeWon: false,
    refundState: null,
    refundedMinor: null,
    refundFeeMinor: null,
  },
  platformCreated: {
    kind: 'reversal',
    eventId: 'evt_dsp_created_platform_1',
    eventType: 'dispute.created',
    scope: 'platform',
    accountReference: null,
    providerReference: null,
    chargeReference: CHARGE,
    operationReference: null,
    partnerReversalId: `dispute.${DISPUTE}`,
    disputeWon: false,
    refundState: null,
    refundedMinor: null,
    refundFeeMinor: null,
  },
  platformLost: {
    kind: 'reversal',
    eventId: 'evt_dsp_updated_platform_2',
    eventType: 'dispute.updated',
    scope: 'platform',
    accountReference: null,
    providerReference: null,
    chargeReference: CHARGE,
    operationReference: null,
    partnerReversalId: `dispute.${DISPUTE}`,
    disputeWon: false,
    refundState: null,
    refundedMinor: null,
    refundFeeMinor: null,
  },
};

test('a platform dispute event carries amount, status, deadline and fee', () => {
  const provider = quiet();
  const result = signed(provider, body('dispute-created-platform'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.event, {
    kind: 'dispute',
    eventId: 'evt_dsp_created_platform_1',
    eventType: 'dispute.created',
    scope: 'platform',
    partnerDisputeId: DISPUTE,
    chargeReference: CHARGE,
    providerReference: null,
    operationReference: null,
    status: 'open',
    amountMinor: 1000000n,
    currency: 'NGN',
    reason: 'fraudulent',
    respondBy: new Date('2026-12-02T00:00:00Z'),
    // The partner's docs name no fee field on a dispute or its events: the fee is unknown here, and
    // Task 9 opens an issue rather than post a guess (R6).
    feeMinor: null,
    feeCurrency: null,
    occurredAt: new Date('2026-11-19T12:00:00Z'),
  });

  const lost = signed(provider, body('dispute-updated-lost-platform'));
  assert.equal(lost.ok, true);
  assert.equal(lost.event.kind, 'dispute');
  assert.equal(lost.event.eventType, 'dispute.updated');
  assert.equal(lost.event.status, 'lost');
  assert.deepEqual(lost.event.occurredAt, new Date('2026-11-30T09:00:00Z'));

  // Every status the docs list, in TipMe's words. `prevented` (events only) moved no money.
  for (const [partner, ours] of [
    ['needs_response', 'open'],
    ['under_review', 'responded'],
    ['won', 'won'],
    ['lost', 'lost'],
    ['closed', 'closed'],
    ['prevented', 'closed'],
  ]) {
    const event = signed(
      provider,
      withData('dispute-created-platform', { status: partner }),
    ).event;
    assert.equal(event.status, ours, partner);
  }

  // Another currency is read at its own precision; no deadline is null, not a guess.
  const usd = signed(
    provider,
    withData('dispute-created-platform', {
      amount: '75.00',
      currency: 'USD',
      response_deadline_at: null,
    }),
  ).event;
  assert.equal(usd.amountMinor, 7500n);
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.respondBy, null);
});

test("a connected account's dispute is still a reversal, unchanged", () => {
  const provider = quiet();
  assert.deepEqual(signed(provider, body('dispute-created-connected')), {
    ok: true,
    event: BEFORE.connected,
  });
  assert.deepEqual(
    signed(provider, withData('dispute-created-connected', { status: 'lost' }))
      .event,
    { ...BEFORE.connected },
  );
  // TipMe's own dispute events other than created and updated keep the reversal path too.
  for (const type of ['dispute.lost', 'chargeback.created']) {
    const event = signed(provider, {
      ...body('dispute-created-platform'),
      type,
    }).event;
    assert.equal(event.kind, 'reversal', type);
    assert.equal(event.scope, 'platform', type);
  }
  // Without TipMe's organization set, nothing is TipMe's: a reversal, as before.
  const unset = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: [SECRET],
    fetchImpl: async () => {
      throw new Error('no request expected');
    },
  });
  assert.equal(
    signed(unset, body('dispute-created-platform')).event.kind,
    'reversal',
  );
  // P5: until disputes are routed (Task 9), TipMe's own dispute reaches Pro billing in the exact
  // shape it had before this change.
  assert.deepEqual(
    disputeAsReversal(signed(provider, body('dispute-created-platform')).event),
    BEFORE.platformCreated,
  );
  assert.deepEqual(
    disputeAsReversal(
      signed(provider, body('dispute-updated-lost-platform')).event,
    ),
    BEFORE.platformLost,
  );
  assert.equal(
    disputeAsReversal(
      signed(provider, withData('dispute-created-platform', { status: 'won' }))
        .event,
    ).disputeWon,
    true,
  );
});

test('a dispute event with a bad signature, a stale time, or an unreadable amount is refused', () => {
  const provider = quiet();
  const event = body('dispute-created-platform');
  assert.deepEqual(
    signed(provider, event, { secret: 'not-the-secret-0123456789' }),
    { ok: false, reason: 'bad_signature' },
  );
  assert.deepEqual(
    signed(provider, event, { at: new Date(NOW.getTime() - 301_000) }),
    { ok: false, reason: 'stale' },
  );
  // Only the signature and the envelope can refuse (400): the partner reads any other 4xx as a
  // refusal and stops, so a dispute would be lost. A signed dispute TipMe can't read as one is
  // still not a `dispute`: it falls back to today's reversal, which reaches Pro billing or staff
  // exactly as before (review fix 1, P5).
  const raw = Buffer.from('{"id":"evt_x","type":"dispute.created"');
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), raw]))
    .digest('hex');
  assert.deepEqual(
    provider.verifyWebhook(
      raw,
      { 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` },
      NOW,
    ),
    { ok: false, reason: 'malformed' },
  );
  assert.deepEqual(signed(provider, { ...event, id: undefined }), {
    ok: false,
    reason: 'malformed',
  });
  const reversal = BEFORE.platformCreated;
  for (const [data, partnerReversalId] of [
    [{ amount: 'lots' }],
    [{ amount: '-5.00' }],
    [{ amount: '0.00' }],
    [{ amount: '10000.001' }],
    [{ amount: 10000 }],
    [{ currency: undefined }],
    [{ currency: 'naira' }],
    [{ status: 'pending_magic' }],
    [{ status: undefined }],
    [{ response_deadline_at: 'next week' }],
    [{ dispute_id: undefined }, null],
    [{ dispute_id: 'dsp bad:id' }, null],
    // The older shape today's code also reads: a chargeback id, no dispute id.
    [{ dispute_id: undefined, chargeback_id: 'cb_7' }, 'dispute.cb_7'],
  ]) {
    assert.deepEqual(
      signed(provider, withData('dispute-created-platform', data)),
      {
        ok: true,
        event: {
          ...reversal,
          ...(partnerReversalId === undefined ? {} : { partnerReversalId }),
        },
      },
      JSON.stringify(data),
    );
  }
  // No event time at all (no created_at, no updated_at): today's reversal too.
  const { created_at: _at, ...untimed } = withData('dispute-created-platform', {
    updated_at: undefined,
  });
  assert.deepEqual(signed(provider, untimed), { ok: true, event: reversal });
});

test('free-text reasons never leave the adapter', () => {
  const provider = quiet();
  const text =
    'Customer says the card was stolen, call Ada on 08031234567 at ada@example.com';
  for (const reason of [
    text,
    'Fraudulent',
    'fraud ulent',
    'a'.repeat(41),
    '',
    42,
  ]) {
    const result = signed(
      provider,
      withData('dispute-created-platform', { reason }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.event.reason, null, String(reason));
    const serialised = JSON.stringify(result.event, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    );
    assert.equal(serialised.includes('stolen'), false);
    assert.equal(serialised.includes('08031234567'), false);
  }
  for (const reason of ['fraudulent', 'product_not_received', 'a'.repeat(40)])
    assert.equal(
      signed(provider, withData('dispute-created-platform', { reason })).event
        .reason,
      reason,
    );
  // The reversal Pro billing sees carries no reason at all.
  assert.equal(
    'reason' in
      disputeAsReversal(
        signed(provider, body('dispute-created-platform')).event,
      ),
    false,
  );
});

test('evidence is submitted once per key; a 5xx is uncertain', async () => {
  // The pretend partner keeps one submission per idempotency key, as the idempotency guide says.
  const seen = new Map();
  const { provider, calls } = fake((call) => {
    const key = call.headers['Idempotency-Key'];
    if (call.method === 'PATCH')
      return jsonResponse(body('dispute-evidence-saved'));
    if (!seen.has(key)) seen.set(key, body('dispute-submitted'));
    return jsonResponse(seen.get(key));
  });
  const input = {
    partnerDisputeId: DISPUTE,
    text: 'The supporter tipped on 19 Nov and was sent a receipt.',
    fileRefs: ['upl_9f2c7b3d1e45'],
    idempotencyKey: 'tipme-dispute-evidence-0193f7a2',
  };
  assert.deepEqual(await provider.submitDisputeEvidence(input), {
    state: 'submitted',
  });
  assert.deepEqual(await provider.submitDisputeEvidence(input), {
    state: 'submitted',
  });

  assert.equal(calls.length, 4);
  const [save, submit] = calls;
  assert.equal(save.method, 'PATCH');
  assert.equal(save.path, `/v1/disputes/${DISPUTE}/evidence`);
  assert.deepEqual(save.body, {
    notes: input.text,
    uncategorized_attachment_id: 'upl_9f2c7b3d1e45',
  });
  assert.equal(submit.method, 'POST');
  assert.equal(submit.path, `/v1/disputes/${DISPUTE}/submit`);
  assert.deepEqual(submit.body, {});
  // TipMe's own dispute: never as an account.
  for (const call of calls)
    assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
  // The same key both times, so the partner submits once.
  const submitKeys = new Set(
    calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.headers['Idempotency-Key']),
  );
  assert.equal(submitKeys.size, 1);
  assert.equal(seen.size, 1);
  const saveKeys = new Set(
    calls
      .filter((call) => call.method === 'PATCH')
      .map((call) => call.headers['Idempotency-Key']),
  );
  assert.equal(saveKeys.size, 1);
  assert.notDeepEqual([...saveKeys], [...submitKeys]);

  // A 5xx or a lost answer on either step is uncertain, never "not submitted".
  for (const answers of [
    [jsonResponse({ detail: 'x', error_code: 'INTERNAL_SERVER_ERROR' }, 500)],
    [
      jsonResponse(body('dispute-evidence-saved')),
      jsonResponse({ detail: 'x', error_code: 'BAD_GATEWAY' }, 502),
    ],
    [jsonResponse(body('dispute-evidence-saved')), new TypeError('reset')],
    // An answer about another dispute can't prove this one was submitted.
    [
      jsonResponse(body('dispute-evidence-saved')),
      jsonResponse({ ...body('dispute-submitted'), dispute_id: 'dsp_other' }),
    ],
  ]) {
    const { provider: failing } = fake(answers);
    await assert.rejects(
      failing.submitDisputeEvidence(input),
      UncertainProviderOutcomeError,
    );
  }
  // A refusal while the dispute is still editable is definite: nothing was submitted.
  const { provider: refusing, calls: refusedCalls } = fake([
    jsonResponse(body('dispute-evidence-saved')),
    jsonResponse({ detail: 'bad', error_code: 'VALIDATION_ERROR' }, 400),
    jsonResponse({
      ...body('dispute-get-under-review'),
      status: 'needs_response',
      is_response_editable: true,
    }),
  ]);
  await assert.rejects(refusing.submitDisputeEvidence(input), (error) => {
    assert.ok(error instanceof DisputeEvidenceRefusedError);
    assert.equal(error.providerCode, 'VALIDATION_ERROR');
    return true;
  });
  assert.equal(refusedCalls[2].method, 'GET');
  assert.equal(refusedCalls[2].path, `/v1/disputes/${DISPUTE}`);
  // Bad input is refused before anything is sent.
  const { provider: unsent, calls: none } = fake([]);
  for (const bad of [
    { ...input, partnerDisputeId: 'dsp:x' },
    { ...input, idempotencyKey: 'bad key' },
    { ...input, text: '' },
    { ...input, fileRefs: ['upl_1', 'upl_2'] },
  ])
    await assert.rejects(unsent.submitDisputeEvidence(bad));
  assert.equal(none.length, 0);
});

test('a refusal after a lost submit answer is read back: submitted, uncertain, or refused', async () => {
  const input = {
    partnerDisputeId: DISPUTE,
    text: 'The supporter tipped on 19 Nov and was sent a receipt.',
    fileRefs: [],
    idempotencyKey: 'tipme-dispute-evidence-0193f7a3',
  };
  const saved = () => jsonResponse(body('dispute-evidence-saved'));
  const notEditable = () =>
    jsonResponse(
      { detail: 'Dispute is not editable', error_code: 'VALIDATION_ERROR' },
      400,
    );
  // The first try: evidence saved, the submit answer is a 5xx, so the outcome is unknown.
  const first = fake([
    saved(),
    jsonResponse({ detail: 'x', error_code: 'INTERNAL_SERVER_ERROR' }, 500),
  ]);
  await assert.rejects(
    first.provider.submitDisputeEvidence(input),
    UncertainProviderOutcomeError,
  );
  // The retry: submit says "not editable", and the dispute reads under review: it was submitted.
  const retry = fake([
    saved(),
    notEditable(),
    jsonResponse(body('dispute-get-under-review')),
  ]);
  assert.deepEqual(await retry.provider.submitDisputeEvidence(input), {
    state: 'submitted',
  });
  assert.deepEqual(
    retry.calls.map((call) => [call.method, call.path]),
    [
      ['PATCH', `/v1/disputes/${DISPUTE}/evidence`],
      ['POST', `/v1/disputes/${DISPUTE}/submit`],
      ['GET', `/v1/disputes/${DISPUTE}`],
    ],
  );
  assert.equal(Object.hasOwn(retry.calls[2].headers, 'X-Account-Id'), false);
  // The evidence save itself refused because the dispute is locked: read back the same way.
  const locked = fake([
    notEditable(),
    jsonResponse({
      ...body('dispute-get-under-review'),
      status: 'lost',
      is_response_editable: false,
    }),
  ]);
  assert.deepEqual(await locked.provider.submitDisputeEvidence(input), {
    state: 'submitted',
  });
  // A read-back that can't tell (fails, another dispute, unknown state) is uncertain.
  for (const readBack of [
    jsonResponse({ detail: 'x', error_code: 'INTERNAL_SERVER_ERROR' }, 500),
    new TypeError('reset'),
    jsonResponse({ ...body('dispute-get-under-review'), dispute_id: 'dsp_x' }),
    jsonResponse({
      ...body('dispute-get-under-review'),
      status: 'mystery',
      is_response_editable: true,
    }),
    jsonResponse({ dispute_id: DISPUTE }),
  ]) {
    const unclear = fake([saved(), notEditable(), readBack]);
    await assert.rejects(
      unclear.provider.submitDisputeEvidence(input),
      UncertainProviderOutcomeError,
    );
  }
});

test('a dispute file is uploaded as one multipart file and its id comes back', async () => {
  const { provider, calls } = fake([jsonResponse(body('dispute-upload'))]);
  const bytes = Buffer.from('%PDF-1.4 receipt');
  assert.deepEqual(
    await provider.uploadDisputeFile({
      partnerDisputeId: DISPUTE,
      bytes,
      contentType: 'application/pdf',
    }),
    { fileRef: 'upl_9f2c7b3d1e45' },
  );
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/disputes/uploads');
  assert.ok(call.rawBody instanceof FormData);
  const file = call.rawBody.get('file');
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.name, `${DISPUTE}.pdf`);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  // fetch sets the multipart boundary itself.
  assert.equal(Object.hasOwn(call.headers, 'content-type'), false);
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);

  // Over the documented 10 MB, or an empty file, is refused before sending.
  const { provider: unsent, calls: none } = fake([]);
  await assert.rejects(
    unsent.uploadDisputeFile({
      partnerDisputeId: DISPUTE,
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
      contentType: 'image/png',
    }),
  );
  await assert.rejects(
    unsent.uploadDisputeFile({
      partnerDisputeId: DISPUTE,
      bytes: Buffer.alloc(0),
      contentType: 'image/png',
    }),
  );
  assert.equal(none.length, 0);
});

test("TipMe's disputes are listed across every page, in TipMe's words", async () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const { provider, calls } = fake([jsonResponse(body('dispute-list'))]);
  assert.deepEqual(await provider.listDisputes(since), [
    {
      partnerDisputeId: DISPUTE,
      status: 'responded',
      amountMinor: 1000000n,
      currency: 'NGN',
      chargeReference: CHARGE,
    },
    {
      partnerDisputeId: 'dsp_3e7b1c9a2f48',
      status: 'open',
      amountMinor: 7500n,
      currency: 'USD',
      chargeReference: 'ch_8f3a1c9b4e72',
    },
  ]);
  const [call] = calls;
  assert.equal(call.method, 'GET');
  const url = new URL(call.path, 'https://x');
  assert.equal(url.pathname, '/v1/disputes');
  assert.equal(url.searchParams.get('from_date'), since.toISOString());
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);

  // More than one page: read until the total is reached.
  const item = body('dispute-list').items[0];
  const page = (from, count, total) =>
    jsonResponse({
      total,
      items: Array.from({ length: count }, (_, i) => ({
        ...item,
        dispute_id: `dsp_${from + i}`,
      })),
    });
  const paged = fake([page(0, 100, 150), page(100, 50, 150)]);
  const rows = await paged.provider.listDisputes(since);
  assert.equal(rows.length, 150);
  assert.equal(
    new URL(paged.calls[1].path, 'https://x').searchParams.get('offset'),
    '100',
  );

  // A dispute created between pages shifts the list (newest first): the total moves, and the
  // read is uncertain rather than a list with a repeat or a gap.
  const moved = fake([page(0, 100, 150), page(99, 51, 151)]);
  await assert.rejects(
    moved.provider.listDisputes(since),
    UncertainProviderOutcomeError,
  );
  // A repeat with the same total is listed once.
  const repeated = fake([
    jsonResponse({
      total: 2,
      items: [item, item, { ...item, dispute_id: 'dsp_2' }],
    }),
  ]);
  assert.deepEqual(
    (await repeated.provider.listDisputes(since)).map(
      (row) => row.partnerDisputeId,
    ),
    [DISPUTE, 'dsp_2'],
  );

  // A short page before the total, or an unreadable row, is never a partial answer.
  const short = fake([page(0, 10, 150)]);
  await assert.rejects(short.provider.listDisputes(since));
  const unreadable = fake([
    jsonResponse({ total: 1, items: [{ ...item, status: 'mystery' }] }),
  ]);
  await assert.rejects(unreadable.provider.listDisputes(since));
});
