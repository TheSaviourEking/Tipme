import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  createZeptoMailProvider,
  MailRejectedError,
  MailTemporaryError,
} from '../dist/index.js';
import { runMailProviderConformance } from '../dist/conformance.js';

const KEY = 'zepto-webhook-auth-key-0123456789';
const BASE = 'https://api.zeptomail.example';

/** A ZeptoMail webhook body: one form parameter whose value is the event JSON. */
function signed(event, signedAt, key = KEY) {
  const json = JSON.stringify(event);
  const body = Buffer.from(`payload=${encodeURIComponent(json)}`);
  const s = createHmac('sha256', key).update(json).digest('base64');
  return {
    body,
    headers: {
      'producer-signature': `ts=${signedAt.getTime()};s=${encodeURIComponent(s)};s-algorithm=HmacSHA256`,
    },
  };
}

const event = (name, reference, extra = {}) => ({
  event_name: [name],
  event_message: [
    {
      email_info: {
        email_reference: 'zref-1',
        client_reference: reference,
        subject: 'Hello',
        to: [{ email_address: { address: 'ada@example.com' } }],
        processed_time: '2026-10-30T10:00:00Z',
        object: 'email',
      },
      event_data: [
        {
          details: [{ time: '2026-10-30T10:00:05Z', ...extra }],
          object: name,
        },
      ],
      request_id: 'zreq-1',
    },
  ],
  mailagent_key: 'agent-1',
  webhook_request_id: 'whr-1',
});

function harness() {
  const queue = [];
  const fetchImpl = async (url, init) => {
    const next = queue.shift();
    if (next.kind === 'timeout')
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      );
    if (next.kind === 'ok')
      return Response.json(
        { data: [{ code: 'EM_104' }], request_id: next.id, object: 'email' },
        { status: 201 },
      );
    if (next.kind === 'temporary')
      return Response.json({ error: { code: next.code } }, { status: 503 });
    return Response.json(
      {
        error: {
          code: 'TM_4001',
          details: [{ code: next.code, message: 'x', target: 'to' }],
        },
      },
      { status: 400 },
    );
  };
  const provider = createZeptoMailProvider({
    apiKey: 'send-token',
    apiBase: BASE,
    webhookKey: KEY,
    fetchImpl,
    timeoutMs: 50,
  });
  return {
    provider,
    respond: (outcome) => queue.push(outcome),
    signedBounce: (reference, at) => signed(event('hardbounce', reference), at),
    signedUnknown: (at) => signed(event('email_sent_report', null), at),
    staleAfterMs: 5 * 60_000,
  };
}

test('ZeptoMail meets the shared adapter contract', (t) =>
  runMailProviderConformance(t, harness));

test('sends the documented request shape', async () => {
  let request;
  const provider = createZeptoMailProvider({
    apiKey: 'send-token',
    apiBase: BASE,
    webhookKey: KEY,
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return Response.json({ request_id: 'zreq-9' }, { status: 201 });
    },
    bounceAddress: 'bounce@bounce-zem.mail.usetipme.xyz',
  });
  const sent = await provider.send({
    reference: 'msg-1',
    to: 'ada@example.com',
    from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
    replyTo: 'support@usetipme.xyz',
    subject: 'Hi',
    text: 'Hello',
    html: '<p>Hello</p>',
    headers: { 'List-Unsubscribe': '<https://x/u>' },
    tracking: false,
  });
  assert.deepEqual(sent, { providerMessageId: 'zreq-9' });
  assert.equal(request.url, `${BASE}/v1.1/email`);
  assert.equal(
    request.init.headers.Authorization,
    'Zoho-enczapikey send-token',
  );
  assert.deepEqual(request.body, {
    from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
    to: [{ email_address: { address: 'ada@example.com' } }],
    reply_to: [{ address: 'support@usetipme.xyz' }],
    subject: 'Hi',
    textbody: 'Hello',
    htmlbody: '<p>Hello</p>',
    client_reference: 'msg-1',
    mime_headers: { 'List-Unsubscribe': '<https://x/u>' },
    track_opens: false,
    track_clicks: false,
    bounce_address: 'bounce@bounce-zem.mail.usetipme.xyz',
  });
});

test('maps every documented error code', async () => {
  const temporary = ['LE_101', 'LE_102', 'SMI_115', 'SM_133'];
  const permanent = [
    'SM_111',
    'SM_113',
    'SERR_157',
    'SM_128',
    'AE_101',
    'GE_102',
    'SM_101',
    'SERR_156',
  ];
  for (const code of [...temporary, ...permanent]) {
    const provider = createZeptoMailProvider({
      apiKey: 'k',
      apiBase: BASE,
      webhookKey: KEY,
      fetchImpl: async () =>
        Response.json(
          { error: { code: 'TM_3501', details: [{ code }] } },
          { status: 400 },
        ),
    });
    await assert.rejects(
      provider.send({
        reference: 'r',
        to: 'a@example.com',
        from: { address: 'h@example.com', name: 'T' },
        subject: 's',
        text: 't',
        html: 'h',
        headers: {},
        tracking: true,
      }),
      (error) => {
        const expected = temporary.includes(code)
          ? MailTemporaryError
          : MailRejectedError;
        assert.ok(error instanceof expected, code);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test('click events carry the link key, never the URL', () => {
  const { provider } = harness();
  const now = new Date();
  const result = provider.verifyWebhook(
    ...Object.values(
      signed(
        event('email_link_click', 'msg-2', {
          clicked_link: 'https://usetipme.xyz/dashboard/tips?ml=see_tips',
        }),
        now,
      ),
    ),
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(result.events[0].kind, 'clicked');
  assert.equal(result.events[0].linkKey, 'see_tips');
  assert.equal(result.events[0].reference, 'msg-2');
  assert.ok(!JSON.stringify(result.events[0]).includes('dashboard'));
});

test('a signature with + in the payload verifies', () => {
  const { provider } = harness();
  const now = new Date();
  const data = event('softbounce', 'msg+3', { reason: 'mailbox full + more' });
  const { body, headers } = signed(data, now);
  const result = provider.verifyWebhook(body, headers, now);
  assert.equal(result.ok, true);
  assert.equal(result.events[0].kind, 'soft_bounce');
  assert.equal(result.events[0].reference, 'msg+3');
});

test('a non-HmacSHA256 algorithm is refused', () => {
  const { provider } = harness();
  const now = new Date();
  const { body, headers } = signed(event('hardbounce', 'r'), now);
  headers['producer-signature'] = headers['producer-signature'].replace(
    'HmacSHA256',
    'HmacSHA1',
  );
  assert.deepEqual(provider.verifyWebhook(body, headers, now), {
    ok: false,
    reason: 'signature',
  });
});

test('a complaint is reported as a complaint for the recipient', () => {
  const { provider } = harness();
  const now = new Date();
  const result = provider.verifyWebhook(
    ...Object.values(signed(event('fbl_complaint', 'msg-4'), now)),
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(result.events[0].kind, 'complaint');
  assert.equal(result.events[0].address, 'ada@example.com');
});
