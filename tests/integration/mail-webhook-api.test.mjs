import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { MailWebhookController } from '../../apps/api/dist/mail/mail-webhook.controller.js';
import {
  addressHmac,
  enqueueMail,
  mailSealing,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createBrevoProvider,
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
      SigningCertURL:
        'https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-0123abcdef.pem',
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

test('a certificate fetch that fails is 503, so SNS retries instead of the event being lost', async (t) => {
  const db = await database(t);
  const api = controller(db);
  const ses = api.providers.get('ses');
  ses.prepareWebhook = async () => {
    throw new Error('network');
  };
  assert.equal(
    await status(
      api.receive('ses', { rawBody: Buffer.from('{}'), headers: {} }),
    ),
    503,
  );
});

// Announcements (owner, 14 Nov 2026): Brevo's bounces and spam reports feed the same suppression
// list. Brevo doesn't sign webhooks; it sends the bearer token set on the webhook.
const BREVO_TOKEN = 'brevo-webhook-token-0123456789';
function brevoController(db) {
  return new MailWebhookController(
    new Map(),
    { db: db.db },
    sealing,
    logger,
    async () => {},
    createBrevoProvider({
      apiKey: 'brevo-placeholder-test',
      apiBase: 'https://api.brevo.example',
      fromAddress: 'news@usetipme.xyz',
      webhookToken: BREVO_TOKEN,
      sandbox: true,
    }),
  );
}
const brevoEvent = (event, email, token = BREVO_TOKEN) => ({
  rawBody: Buffer.from(
    JSON.stringify({
      event,
      email,
      'message-id': `<${Math.random()}@smtp-relay.mailin.fr>`,
      ts_event: Math.floor(Date.now() / 1000),
    }),
  ),
  headers: { authorization: `Bearer ${token}` },
});

test('a Brevo bounce or spam report suppresses its address', async (t) => {
  const db = await database(t);
  const brevo = brevoController(db);
  await brevo.receive('brevo', brevoEvent('hard_bounce', 'gone@example.com'));
  await brevo.receive('brevo', brevoEvent('spam', 'annoyed@example.com'));
  const rows = await db.pool.query(
    `SELECT address_hmac, reason FROM mail_suppressions ORDER BY reason`,
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.address_hmac, row.reason]),
    [
      [addressHmac(sealing, 'annoyed@example.com'), 'complaint'],
      [addressHmac(sealing, 'gone@example.com'), 'hard_bounce'],
    ],
  );
});

test('a Brevo webhook without its token is 401; Brevo is unknown where it isn’t set up', async (t) => {
  const db = await database(t);
  assert.equal(
    await status(
      brevoController(db).receive(
        'brevo',
        brevoEvent('hard_bounce', 'gone@example.com', 'wrong-token-0123456789'),
      ),
    ),
    401,
  );
  assert.equal(
    await status(
      controller(db).receive(
        'brevo',
        brevoEvent('hard_bounce', 'x@example.com'),
      ),
    ),
    404,
  );
  const rows = await db.pool.query(`SELECT 1 FROM mail_suppressions`);
  assert.equal(rows.rows.length, 0);
});

// Codes, receipts and alerts through Brevo (owner, 23 Nov 2026): the transactional instance is in
// the providers map, and Brevo's one webhook URL feeds its delivery reports, bounces and spam
// reports onto those messages, with or without announcements set up.
function brevoTransactional() {
  return createBrevoProvider({
    apiKey: 'brevo-placeholder-test',
    apiBase: 'https://api.brevo.example',
    webhookToken: BREVO_TOKEN,
    sandbox: false,
  });
}
const brevoMessageEvent = (event, reference) => {
  const hook = brevoEvent(event, 'tobi@example.com');
  const body = JSON.parse(hook.rawBody.toString('utf8'));
  return {
    ...hook,
    rawBody: Buffer.from(
      JSON.stringify({ ...body, 'X-Mailin-custom': `tipme_ref:${reference}` }),
    ),
  };
};
async function brevoSentCode(db) {
  const { id } = await enqueueMail(db.db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: {
      firstName: 'Tobi',
      netMinor: '180000',
      supporterLabel: 'Ada',
      pretendPayment: false,
    },
    dedupeKey: `brevo.${Math.random()}`,
  });
  await db.pool.query(
    `UPDATE mail_messages SET status = 'sent', provider = 'brevo', provider_message_id = $2 WHERE id = $1`,
    [id, `<${id}@smtp-relay.mailin.fr>`],
  );
  return id;
}

test('Brevo’s webhook reaches the transactional instance when announcements aren’t set up', async (t) => {
  const db = await database(t);
  const brevo = new MailWebhookController(
    new Map([['brevo', brevoTransactional()]]),
    { db: db.db },
    sealing,
    logger,
    async () => {},
    null,
  );
  const id = await brevoSentCode(db);
  assert.deepEqual(
    await brevo.receive('brevo', brevoMessageEvent('hard_bounce', id)),
    { data: { received: 1 } },
  );
  const [row] = (
    await db.pool.query(`SELECT status FROM mail_messages WHERE id = $1`, [id])
  ).rows;
  assert.equal(row.status, 'bounced');
  const suppressed = await db.pool.query(
    `SELECT reason FROM mail_suppressions WHERE address_hmac = $1`,
    [addressHmac(sealing, 'tobi@example.com')],
  );
  assert.equal(suppressed.rows[0]?.reason, 'hard_bounce');
});

test('with both set up, one Brevo webhook feeds codes and announcements alike', async (t) => {
  const db = await database(t);
  const brevo = new MailWebhookController(
    new Map([['brevo', brevoTransactional()]]),
    { db: db.db },
    sealing,
    logger,
    async () => {},
    brevoController(db).announcements,
  );
  const id = await brevoSentCode(db);
  await brevo.receive('brevo', brevoMessageEvent('delivered', id));
  await brevo.receive('brevo', brevoMessageEvent('spam', id));
  const events = await db.pool.query(
    `SELECT kind, provider FROM mail_message_events WHERE message_id = $1 AND provider IS NOT NULL ORDER BY kind`,
    [id],
  );
  assert.deepEqual(
    events.rows.map((r) => [r.kind, r.provider]),
    [
      ['complaint', 'brevo'],
      ['delivered', 'brevo'],
    ],
  );
  const [row] = (
    await db.pool.query(`SELECT status FROM mail_messages WHERE id = $1`, [id])
  ).rows;
  assert.equal(row.status, 'complained');
  assert.equal(
    await status(
      brevo.receive(
        'brevo',
        brevoEvent('hard_bounce', 'x@example.com', 'wrong-token-0123456789'),
      ),
    ),
    401,
  );
});
