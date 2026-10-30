import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { MailWebhookController } from '../../apps/api/dist/mail/mail-webhook.controller.js';
import {
  addressHmac,
  mailSealing,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createSesProvider,
  createZeptoMailProvider,
} from '../../packages/mail/dist/index.js';

// Provider webhooks are verified before anything is stored, accepted for every configured
// provider (active or not), and answered so the provider retries only what failed.

const KEY = 'zepto-webhook-auth-key-0123456789';
const sealing = mailSealing(Buffer.alloc(32, 7));
const logger = { info() {}, warn() {}, error() {} };
const TOPIC = 'arn:aws:sns:eu-north-1:185678361212:tipme-staging-mail-events';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

async function database(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  await db.reset();
  return db;
}

function zeptoBounce(address, signedAt = new Date(), key = KEY) {
  const json = JSON.stringify({
    event_name: ['hardbounce'],
    event_message: [
      {
        email_info: {
          client_reference: null,
          to: [{ email_address: { address } }],
        },
        event_data: [{ details: [{}], object: 'hardbounce' }],
        request_id: 'zreq-1',
      },
    ],
    webhook_request_id: `whr-${Math.random()}`,
  });
  const s = createHmac('sha256', key).update(json).digest('base64');
  return {
    rawBody: Buffer.from(`payload=${encodeURIComponent(json)}`),
    headers: {
      'producer-signature': `ts=${signedAt.getTime()};s=${encodeURIComponent(s)};s-algorithm=HmacSHA256`,
    },
  };
}

function controller(db, confirmed = []) {
  const providers = new Map([
    [
      'zeptomail',
      createZeptoMailProvider({
        apiKey: 'k',
        apiBase: 'https://api.zeptomail.example',
        webhookKey: KEY,
      }),
    ],
    [
      'ses',
      createSesProvider({
        region: 'eu-north-1',
        configurationSet: 'tracked',
        configurationSetUntracked: 'untracked',
        topicArn: TOPIC,
        client: { send: async () => ({}) },
        fetchCert: async () =>
          publicKey.export({ type: 'spki', format: 'pem' }),
      }),
    ],
  ]);
  return new MailWebhookController(
    providers,
    { db: db.db },
    sealing,
    logger,
    async (url) => {
      confirmed.push(url);
    },
  );
}

const status = async (promise) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    return error.getStatus?.() ?? 500;
  }
};

test('a signed bounce suppresses its address', async (t) => {
  const db = await database(t);
  const { rawBody, headers } = zeptoBounce('ada@example.com');
  const result = await controller(db).receive('zeptomail', {
    rawBody,
    headers,
  });
  assert.equal(result.data.received, 1);
  const rows = await db.pool.query(
    'SELECT reason FROM mail_suppressions WHERE address_hmac = $1',
    [addressHmac(sealing, 'ada@example.com')],
  );
  assert.deepEqual(rows.rows, [{ reason: 'hard_bounce' }]);
});

test('an unsigned ZeptoMail webhook is refused with 401 and stores nothing', async (t) => {
  const db = await database(t);
  const { rawBody, headers } = zeptoBounce(
    'ada@example.com',
    new Date(),
    'wrong-key-wrong-key-wrong-key-00',
  );
  assert.equal(
    await status(controller(db).receive('zeptomail', { rawBody, headers })),
    401,
  );
  const rows = await db.pool.query(
    'SELECT count(*)::int AS n FROM mail_message_events',
  );
  assert.equal(rows.rows[0].n, 0);
});

test('a stale webhook is 400', async (t) => {
  const db = await database(t);
  const { rawBody, headers } = zeptoBounce(
    'ada@example.com',
    new Date(Date.now() - 10 * 60_000),
  );
  assert.equal(
    await status(controller(db).receive('zeptomail', { rawBody, headers })),
    400,
  );
});

test('an unconfigured provider is 404', async (t) => {
  const db = await database(t);
  assert.equal(
    await status(
      controller(db).receive('mock', {
        rawBody: Buffer.from('{}'),
        headers: {},
      }),
    ),
    404,
  );
  assert.equal(
    await status(
      controller(db).receive('resend', {
        rawBody: Buffer.from('{}'),
        headers: {},
      }),
    ),
    404,
  );
});

test('a SubscriptionConfirmation is confirmed only for the configured topic', async (t) => {
  const db = await database(t);
  const subscribe = (topic) => {
    const envelope = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'm-1',
      Token: 'tok',
      TopicArn: topic,
      Message: 'confirm',
      SubscribeURL:
        'https://sns.eu-north-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '2',
      SigningCertURL: 'https://sns.eu-north-1.amazonaws.com/cert.pem',
    };
    const canonical = [
      'Message',
      'MessageId',
      'SubscribeURL',
      'Timestamp',
      'Token',
      'TopicArn',
      'Type',
    ]
      .map((k) => `${k}\n${envelope[k]}\n`)
      .join('');
    envelope.Signature = sign(
      'sha256',
      Buffer.from(canonical),
      privateKey,
    ).toString('base64');
    return { rawBody: Buffer.from(JSON.stringify(envelope)), headers: {} };
  };
  const confirmed = [];
  const api = controller(db, confirmed);
  await api.receive('ses', subscribe(TOPIC));
  assert.deepEqual(confirmed, [
    'https://sns.eu-north-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok',
  ]);
  assert.equal(
    await status(
      api.receive('ses', subscribe('arn:aws:sns:eu-north-1:1:other')),
    ),
    401,
  );
  assert.equal(confirmed.length, 1);
});
