import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  announcementMailProvider,
  configuredMailProviderNames,
  createBrevoProvider,
  mailSettingsShape,
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
} from '../dist/index.js';
import { z } from 'zod';
import { checkMailSettings } from '../dist/index.js';

// The announcement provider (owner, 14 Nov 2026): announcements go through Brevo only, and never
// fall back to the provider that sends sign-in codes. Requests follow Brevo's documented API
// (POST /v3/smtp/email, `api-key` header, 201 { messageId }). Nothing here reaches Brevo: every
// request goes to a stub, and the adapter's sandbox setting adds Brevo's `X-Sib-Sandbox: drop`.
const BASE = 'https://api.brevo.example';
const TOKEN = 'brevo-webhook-token-0123456789';

const mail = {
  reference: '01a18300-0000-7000-8000-00000000c0f1',
  to: 'ada@example.com',
  from: { address: 'news@mail.usetipme.xyz', name: 'TipMe News' },
  replyTo: 'support@usetipme.xyz',
  subject: 'Lower fees on TipMe',
  text: 'Hello',
  html: '<p>Hello</p>',
  headers: {
    'List-Unsubscribe': '<https://api.usetipme.xyz/v1/mail/unsubscribe?t=a>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
  tracking: true,
};

function provider(answer, extra = {}) {
  const requests = [];
  const brevo = createBrevoProvider({
    apiKey: 'brevo-placeholder-test',
    apiBase: BASE,
    fromAddress: 'news@usetipme.xyz',
    webhookToken: TOKEN,
    sandbox: false,
    timeoutMs: 50,
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return answer(init);
    },
    ...extra,
  });
  return { brevo, requests };
}

const created = () =>
  Response.json(
    { messageId: '<2026111410.1@smtp-relay.mailin.fr>' },
    {
      status: 201,
    },
  );

test('Brevo may carry marketing mail, and is named brevo', () => {
  const { brevo } = provider(created);
  assert.equal(brevo.name, 'brevo');
  assert.deepEqual(brevo.capabilities, { marketing: true });
});

test('sends the documented request, from the announcement address, with our reference', async () => {
  const { brevo, requests } = provider(created);
  assert.deepEqual(await brevo.send(mail), {
    providerMessageId: '<2026111410.1@smtp-relay.mailin.fr>',
  });
  const [request] = requests;
  assert.equal(request.url, `${BASE}/v3/smtp/email`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['api-key'], 'brevo-placeholder-test');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, {
    sender: { email: 'news@usetipme.xyz', name: 'TipMe News' },
    to: [{ email: 'ada@example.com' }],
    replyTo: { email: 'support@usetipme.xyz' },
    subject: 'Lower fees on TipMe',
    htmlContent: '<p>Hello</p>',
    textContent: 'Hello',
    headers: {
      'List-Unsubscribe': '<https://api.usetipme.xyz/v1/mail/unsubscribe?t=a>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Mailin-custom': `tipme_ref:${mail.reference}`,
    },
  });
});

test('sandbox mode asks Brevo to drop the mail', async () => {
  const { brevo, requests } = provider(created, { sandbox: true });
  await brevo.send(mail);
  assert.equal(requests[0].body.headers['X-Sib-Sandbox'], 'drop');
});

test('a refusal is permanent; a rate limit, an outage or a timeout is temporary', async () => {
  const cases = [
    [
      400,
      { code: 'invalid_parameter' },
      MailRejectedError,
      'invalid_parameter',
    ],
    [401, { code: 'unauthorized' }, MailRejectedError, 'unauthorized'],
    [429, {}, MailTemporaryError, 'http_429'],
    [503, {}, MailTemporaryError, 'http_503'],
  ];
  for (const [status, body, kind, code] of cases) {
    const { brevo } = provider(() => Response.json(body, { status }));
    await assert.rejects(brevo.send(mail), (error) => {
      assert.ok(error instanceof kind, String(status));
      assert.equal(error.code, code);
      return true;
    });
  }
  const { brevo } = provider(
    (init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  );
  await assert.rejects(brevo.send(mail), (error) => {
    assert.ok(error instanceof MailTemporaryError);
    assert.equal(error.code, 'timeout');
    return true;
  });
});

// Out of credits (Brevo's free plan: 300 emails a day). Brevo's reference for POST /v3/smtp/email
// (read 15 Nov 2026) lists only 201, 202 and 400, and its 400 `code` list holds both
// `not_enough_credits` and `Insufficient credits`. That is a pause until credits come back, never a
// refusal: a quota error is a temporary error the outbox defers without using up attempts.
test('out of credits is a quota pause, not a refusal; other 400s are still refused', async () => {
  const quota = [
    [400, { code: 'not_enough_credits', message: 'Not enough credits' }],
    [400, { code: 'NOT_ENOUGH_CREDITS' }],
    [400, { code: 'Insufficient credits' }],
    [400, { code: 'bad_request', message: 'Insufficient credits to send' }],
    [402, { code: 'not_enough_credits' }],
  ];
  for (const [status, body] of quota) {
    const { brevo } = provider(() => Response.json(body, { status }));
    await assert.rejects(brevo.send(mail), (error) => {
      assert.ok(error instanceof MailQuotaError, JSON.stringify(body));
      assert.ok(error instanceof MailTemporaryError);
      assert.equal(error.code, 'not_enough_credits');
      return true;
    });
  }
  for (const body of [
    { code: 'invalid_parameter', message: 'email is not valid' },
    { code: 'permission_denied' },
    { code: 'account_under_validation' },
  ]) {
    const { brevo } = provider(() => Response.json(body, { status: 400 }));
    await assert.rejects(brevo.send(mail), (error) => {
      assert.ok(error instanceof MailRejectedError, body.code);
      assert.ok(!(error instanceof MailQuotaError));
      assert.equal(error.code, body.code);
      return true;
    });
  }
});

const hook = (payload, token = TOKEN) => ({
  body: Buffer.from(JSON.stringify(payload)),
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const event = (name, extra = {}) => ({
  event: name,
  email: 'ada@example.com',
  id: 123,
  'message-id': '<2026111410.1@smtp-relay.mailin.fr>',
  ts_event: 1_794_650_000,
  'X-Mailin-custom': `tipme_ref:${mail.reference}`,
  ...extra,
});

test('webhooks need the bearer token (Brevo does not sign them)', () => {
  const { brevo } = provider(created);
  const now = new Date();
  for (const token of [null, 'wrong-token-0123456789-abcdefg'])
    assert.deepEqual(
      brevo.verifyWebhook(
        ...Object.values(hook(event('hard_bounce'), token)),
        now,
      ),
      { ok: false, reason: 'signature' },
    );
  const { brevo: unset } = provider(created, { webhookToken: undefined });
  assert.deepEqual(
    unset.verifyWebhook(...Object.values(hook(event('hard_bounce'))), now),
    { ok: false, reason: 'signature' },
  );
});

test('bounces and spam reports become events on our message', () => {
  const { brevo } = provider(created);
  const now = new Date();
  const bounce = brevo.verifyWebhook(
    ...Object.values(hook(event('hard_bounce'))),
    now,
  );
  assert.equal(bounce.ok, true);
  assert.deepEqual(bounce.events, [
    {
      kind: 'hard_bounce',
      providerEventId:
        '<2026111410.1@smtp-relay.mailin.fr>:hard_bounce:1794650000',
      occurredAt: new Date(1_794_650_000_000),
      address: 'ada@example.com',
      providerMessageId: '<2026111410.1@smtp-relay.mailin.fr>',
      reference: mail.reference,
      linkKey: null,
    },
  ]);
  const both = brevo.verifyWebhook(
    ...Object.values(
      hook([event('spam'), event('soft_bounce'), event('unsubscribed')]),
    ),
    now,
  );
  assert.deepEqual(
    both.events.map((e) => e.kind),
    ['complaint', 'soft_bounce'],
  );
  const click = brevo.verifyWebhook(
    ...Object.values(
      hook(
        event('click', {
          link: 'https://usetipme.xyz/pro?ml=announcement_button',
        }),
      ),
    ),
    now,
  );
  assert.equal(click.events[0].kind, 'clicked');
  assert.equal(click.events[0].linkKey, 'announcement_button');
  assert.deepEqual(
    brevo.verifyWebhook(Buffer.from('not json'), hook({}).headers, now),
    { ok: false, reason: 'malformed' },
  );
});

const settings = (extra = {}) => ({
  NODE_ENV: 'production',
  MAIL_DEFAULT_PROVIDER: 'zeptomail',
  ZEPTOMAIL_API_KEY: 'zepto-key-123',
  ZEPTOMAIL_API_BASE: 'https://api.zeptomail.com',
  ZEPTOMAIL_WEBHOOK_KEY: 'zepto-hook-123',
  SES_REGION: 'eu-north-1',
  ...extra,
});

test('the announcement provider is Brevo when set, the pretend inbox outside production, else none', () => {
  const sink = async () => {};
  assert.equal(announcementMailProvider(settings(), sink), null);
  assert.equal(
    announcementMailProvider(
      settings({
        BREVO_API_KEY: 'brevo-placeholder-real',
        ANNOUNCEMENT_FROM_ADDRESS: 'news@usetipme.xyz',
      }),
      sink,
    )?.name,
    'brevo',
  );
  assert.equal(
    announcementMailProvider(settings({ NODE_ENV: 'development' }), sink)?.name,
    'mock',
  );
  // Never part of the providers every other email can use or be switched to.
  assert.ok(
    !configuredMailProviderNames(
      settings({
        BREVO_API_KEY: 'brevo-placeholder-real',
        ANNOUNCEMENT_FROM_ADDRESS: 'news@usetipme.xyz',
      }),
    ).has('brevo'),
  );
});

test('the Brevo key and the sender address are set together, and Brevo is never the default', () => {
  const schema = z
    .object({ NODE_ENV: z.string().optional(), ...mailSettingsShape })
    .superRefine((value, context) => checkMailSettings(value, context));
  const problems = (extra) => {
    const result = schema.safeParse(settings(extra));
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join('.'));
  };
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ BREVO_API_KEY: 'brevo-placeholder-real' }), [
    'ANNOUNCEMENT_FROM_ADDRESS',
  ]);
  assert.deepEqual(
    problems({ ANNOUNCEMENT_FROM_ADDRESS: 'news@usetipme.xyz' }),
    ['BREVO_API_KEY'],
  );
  assert.ok(problems({ MAIL_DEFAULT_PROVIDER: 'brevo' }).length > 0);
  const parsed = schema.parse(
    settings({
      BREVO_SANDBOX: 'on',
      BREVO_API_KEY: 'brevo-placeholder-real',
      ANNOUNCEMENT_FROM_ADDRESS: 'news@usetipme.xyz',
    }),
  );
  assert.equal(parsed.BREVO_SANDBOX, true);
  assert.equal(schema.parse(settings()).BREVO_SANDBOX, false);
});
