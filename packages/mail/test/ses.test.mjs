import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { createSesProvider } from '../dist/index.js';
import { runMailProviderConformance } from '../dist/conformance.js';

const REGION = 'eu-north-1';
const TOPIC = 'arn:aws:sns:eu-north-1:185678361212:tipme-staging-mail-events';
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123abcdef.pem`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

/** An SNS envelope signed the way SNS signs (SignatureVersion 2, SHA256withRSA). */
function snsEnvelope(fields, signedAt, overrides = {}) {
  const envelope = {
    Type: 'Notification',
    MessageId: `sns-${Math.random().toString(36).slice(2)}`,
    TopicArn: TOPIC,
    Timestamp: signedAt.toISOString(),
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    ...fields,
    ...overrides,
  };
  const order =
    envelope.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : [
          'Message',
          'MessageId',
          'SubscribeURL',
          'Timestamp',
          'Token',
          'TopicArn',
          'Type',
        ];
  const canonical = order
    .filter((key) => envelope[key] !== undefined)
    .map((key) => `${key}\n${envelope[key]}\n`)
    .join('');
  envelope.Signature = sign(
    'sha256',
    Buffer.from(canonical),
    privateKey,
  ).toString('base64');
  return {
    body: Buffer.from(JSON.stringify(envelope)),
    headers: { 'x-amz-sns-message-type': envelope.Type },
  };
}

const sesEvent = (eventType, reference, extra = {}) => ({
  Message: JSON.stringify({
    eventType,
    mail: {
      messageId: 'ses-msg-1',
      timestamp: '2026-10-30T10:00:00.000Z',
      destination: ['ada@example.com'],
      tags: { ref: [reference] },
    },
    ...extra,
  }),
});

function harness() {
  const queue = [];
  const sentCommands = [];
  const client = {
    async send(command) {
      sentCommands.push(command);
      if (command.constructor.name === 'GetAccountCommand')
        return {
          ProductionAccessEnabled: false,
          SendQuota: { Max24HourSend: 200 },
        };
      const next = queue.shift();
      if (next.kind === 'ok') return { MessageId: next.id };
      if (next.kind === 'timeout') {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      const error = new Error(next.code);
      error.name =
        next.kind === 'permanent'
          ? 'MessageRejected'
          : 'TooManyRequestsException';
      error.$metadata = {
        httpStatusCode: next.kind === 'permanent' ? 400 : 429,
      };
      throw error;
    },
  };
  const provider = createSesProvider({
    region: REGION,
    configurationSet: 'tipme-staging-tracked',
    configurationSetUntracked: 'tipme-staging-untracked',
    topicArn: TOPIC,
    client,
    fetchCert: async (url) => {
      assert.equal(url, CERT_URL);
      return PEM;
    },
  });
  return {
    provider,
    sentCommands,
    respond: (outcome) => queue.push(outcome),
    signedBounce: (reference, at) =>
      snsEnvelope(
        sesEvent('Bounce', reference, {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'ada@example.com' }],
            timestamp: '2026-10-30T10:00:05.000Z',
          },
        }),
        at,
      ),
    signedUnknown: (at) => snsEnvelope(sesEvent('Send', 'x'), at),
    staleAfterMs: 60 * 60_000,
  };
}

const mail = (tracking) => ({
  reference: 'msg-1',
  to: 'ada@example.com',
  from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
  replyTo: 'support@usetipme.xyz',
  subject: 'Hi',
  text: 'Hello',
  html: '<p>Hello</p>',
  headers: { 'List-Unsubscribe': '<https://x/u>' },
  tracking,
});

const verifyNow = async (provider, signed) => {
  const now = new Date();
  await provider.prepareWebhook(signed.body);
  return provider.verifyWebhook(signed.body, signed.headers, now);
};

test('SES meets the shared adapter contract', (t) =>
  runMailProviderConformance(t, harness));

test('tracked and untracked mail use their configuration sets', async () => {
  const h = harness();
  h.respond({ kind: 'ok', id: 'a' });
  h.respond({ kind: 'ok', id: 'b' });
  await h.provider.send(mail(true));
  await h.provider.send(mail(false));
  const [tracked, untracked] = h.sentCommands.map((c) => c.input);
  assert.equal(tracked.ConfigurationSetName, 'tipme-staging-tracked');
  assert.equal(untracked.ConfigurationSetName, 'tipme-staging-untracked');
  assert.deepEqual(tracked.EmailTags, [{ Name: 'ref', Value: 'msg-1' }]);
  assert.deepEqual(tracked.Destination, { ToAddresses: ['ada@example.com'] });
  assert.deepEqual(tracked.ReplyToAddresses, ['support@usetipme.xyz']);
  assert.equal(tracked.FromEmailAddress, '"TipMe" <hello@mail.usetipme.xyz>');
  assert.equal(tracked.Content.Simple.Subject.Data, 'Hi');
  assert.equal(tracked.Content.Simple.Body.Text.Data, 'Hello');
  assert.equal(tracked.Content.Simple.Body.Html.Data, '<p>Hello</p>');
  assert.deepEqual(tracked.Content.Simple.Headers, [
    { Name: 'List-Unsubscribe', Value: '<https://x/u>' },
  ]);
});

test('a certificate URL off sns.<region>.amazonaws.com is refused', async () => {
  const h = harness();
  const signed = snsEnvelope(sesEvent('Bounce', 'r'), new Date(), {
    SigningCertURL: 'https://evil.example/cert.pem',
  });
  assert.deepEqual(await verifyNow(h.provider, signed), {
    ok: false,
    reason: 'signature',
  });
});

test('a message for another topic is refused', async () => {
  const h = harness();
  const signed = snsEnvelope(sesEvent('Bounce', 'r'), new Date(), {
    TopicArn: 'arn:aws:sns:eu-north-1:999999999999:other',
  });
  assert.deepEqual(await verifyNow(h.provider, signed), {
    ok: false,
    reason: 'topic',
  });
});

test('a permanent bounce is hard, a transient one soft', async () => {
  const h = harness();
  const transient = snsEnvelope(
    sesEvent('Bounce', 'r', {
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: 'ada@example.com' }],
        timestamp: '2026-10-30T10:00:05.000Z',
      },
    }),
    new Date(),
  );
  const result = await verifyNow(h.provider, transient);
  assert.equal(result.ok, true);
  assert.equal(result.events[0].kind, 'soft_bounce');
  assert.equal(result.events[0].address, 'ada@example.com');
  assert.equal(result.events[0].providerMessageId, 'ses-msg-1');
});

test('opens, clicks, deliveries and complaints are normalised', async () => {
  const h = harness();
  const cases = [
    ['Open', { open: { timestamp: '2026-10-30T10:01:00.000Z' } }, 'opened'],
    [
      'Click',
      {
        click: {
          timestamp: '2026-10-30T10:02:00.000Z',
          link: 'https://usetipme.xyz/dashboard?ml=open_dashboard',
        },
      },
      'clicked',
    ],
    [
      'Delivery',
      { delivery: { timestamp: '2026-10-30T10:00:10.000Z' } },
      'delivered',
    ],
    [
      'Complaint',
      {
        complaint: {
          complainedRecipients: [{ emailAddress: 'ada@example.com' }],
          timestamp: '2026-10-30T10:03:00.000Z',
        },
      },
      'complaint',
    ],
  ];
  for (const [type, extra, kind] of cases) {
    const result = await verifyNow(
      h.provider,
      snsEnvelope(sesEvent(type, 'msg-7', extra), new Date()),
    );
    assert.equal(result.ok, true, type);
    assert.equal(result.events[0].kind, kind, type);
    assert.equal(result.events[0].reference, 'msg-7', type);
    if (kind === 'clicked')
      assert.equal(result.events[0].linkKey, 'open_dashboard');
  }
});

test('a subscription confirmation is passed back only for the configured topic', async () => {
  const h = harness();
  const confirm = snsEnvelope(
    {
      Type: 'SubscriptionConfirmation',
      Message: 'You have chosen to subscribe',
      Token: 'tok',
      SubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&Token=tok`,
    },
    new Date(),
  );
  const result = await verifyNow(h.provider, confirm);
  assert.deepEqual(result, {
    ok: true,
    events: [],
    confirmSubscriptionUrl: `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&Token=tok`,
  });
});

test('status reports sandbox from GetAccount', async () => {
  const h = harness();
  assert.deepEqual(await h.provider.status(), {
    sandbox: true,
    detail: '200 emails a day',
  });
});

test('only AWS’s certificate path is ever fetched: no queries, other names or other hosts', async () => {
  for (const url of [
    `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123abcdef.pem?n=1.pem`,
    `https://sns.${REGION}.amazonaws.com/other.pem`,
    `https://sns.${REGION}.amazonaws.com:8443/SimpleNotificationService-0123abcdef.pem`,
    `https://user@sns.${REGION}.amazonaws.com/SimpleNotificationService-0123abcdef.pem`,
    `http://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123abcdef.pem`,
  ]) {
    let fetched = 0;
    const provider = createSesProvider({
      region: REGION,
      configurationSet: 'a',
      configurationSetUntracked: 'b',
      topicArn: TOPIC,
      client: { send: async () => ({}) },
      fetchCert: async () => {
        fetched += 1;
        return PEM;
      },
    });
    const signed = snsEnvelope(sesEvent('Bounce', 'r'), new Date(), {
      SigningCertURL: url,
    });
    await provider.prepareWebhook(signed.body);
    assert.equal(fetched, 0, url);
    assert.deepEqual(
      provider.verifyWebhook(signed.body, signed.headers, new Date()),
      { ok: false, reason: 'signature' },
      url,
    );
  }
});

test('a certificate that cannot be fetched is an error the caller can retry', async () => {
  const provider = createSesProvider({
    region: REGION,
    configurationSet: 'a',
    configurationSetUntracked: 'b',
    topicArn: TOPIC,
    client: { send: async () => ({}) },
    fetchCert: async () => {
      throw new Error('network');
    },
  });
  const signed = snsEnvelope(sesEvent('Bounce', 'r'), new Date());
  await assert.rejects(provider.prepareWebhook(signed.body));
});
