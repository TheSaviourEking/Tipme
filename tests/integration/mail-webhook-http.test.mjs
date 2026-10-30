import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  addressHmac,
  mailSealing,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { MAIL_SEAL_KEY, startStack } from './helpers.mjs';

// Through the real HTTP stack, with the content types the providers really send: ZeptoMail posts
// a form body and SNS posts text/plain. Signatures are over exact bytes, so the raw body must
// reach the controller whatever the content type.

const KEY = 'zepto-webhook-auth-key-0123456789';
const TOPIC = 'arn:aws:sns:eu-north-1:185678361212:tipme-staging-mail-events';
const sealing = mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
let stack;
let database;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      ZEPTOMAIL_API_KEY: 'zepto-send-token',
      ZEPTOMAIL_API_BASE: 'https://api.zeptomail.example',
      ZEPTOMAIL_WEBHOOK_KEY: KEY,
      SES_CONFIGURATION_SET: 'tracked',
      SES_CONFIGURATION_SET_UNTRACKED: 'untracked',
      SES_SNS_TOPIC_ARN: TOPIC,
    },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

function zeptoBody(address, id) {
  const json = JSON.stringify({
    event_name: ['hardbounce'],
    event_message: [
      {
        email_info: {
          subject: 'You got a tip',
          to: [{ email_address: { address } }],
        },
        event_data: [{ details: [{}], object: 'hardbounce' }],
      },
    ],
    webhook_request_id: id,
  });
  const s = createHmac('sha256', KEY).update(json).digest('base64');
  return {
    body: new URLSearchParams({ payload: json }).toString(),
    signature: `ts=${Date.now()};s=${encodeURIComponent(s)};s-algorithm=HmacSHA256`,
  };
}

const post = (provider, body, headers) =>
  fetch(`${stack.api}/v1/webhooks/mail/${provider}`, {
    method: 'POST',
    headers,
    body,
  });

test('a signed ZeptoMail form post suppresses its address', async () => {
  const { body, signature } = zeptoBody('ada@example.com', 'whr-http-1');
  const response = await post('zeptomail', body, {
    'content-type': 'application/x-www-form-urlencoded',
    'producer-signature': signature,
  });
  assert.equal(response.status, 200);
  const { rows } = await database.pool.query(
    'SELECT reason FROM mail_suppressions WHERE address_hmac = $1',
    [addressHmac(sealing, 'ada@example.com')],
  );
  assert.deepEqual(rows, [{ reason: 'hard_bounce' }]);
});

test('an SNS text/plain post reaches verification, instead of arriving empty', async () => {
  const response = await post(
    'ses',
    JSON.stringify({
      Type: 'Notification',
      MessageId: 'm',
      TopicArn: TOPIC,
      Timestamp: new Date().toISOString(),
      Message: '{}',
      SignatureVersion: '2',
      Signature: 'AAAA',
      SigningCertURL: 'https://evil.example/cert.pem',
    }),
    { 'content-type': 'text/plain; charset=UTF-8' },
  );
  // 401 is a failed signature check; an empty body would have been 400.
  assert.equal(response.status, 401);
});

test('a webhook body over the limit is refused', async () => {
  const response = await post('zeptomail', 'x'.repeat(300_000), {
    'content-type': 'application/x-www-form-urlencoded',
  });
  assert.equal(response.status, 413);
});

test('other routes still parse JSON as before', async () => {
  const response = await fetch(`${stack.api}/v1/tip-quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"nonsense":true}',
  });
  assert.equal(response.status, 400);
});
