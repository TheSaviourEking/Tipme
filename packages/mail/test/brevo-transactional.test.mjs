import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  announcementMailProvider,
  checkMailSettings,
  configuredMailProviderNames,
  configuredMailProviders,
  createBrevoProvider,
  mailSettingsShape,
} from '../dist/index.js';

// Brevo for codes, receipts and alerts (owner, 23 Nov 2026): a provider staff switch to by hand
// in ops, like ZeptoMail and SES. Off until BREVO_TRANSACTIONAL=on; then it sends each mail from
// its own type's sender (security@, payments@…), never the announcement address, and has its own
// sandbox flag so staging can really deliver sign-in codes. Nothing here reaches Brevo.

const schema = z
  .object({ NODE_ENV: z.string().default('test'), ...mailSettingsShape })
  .superRefine((config, context) => checkMailSettings(config, context));
const parse = (env) => schema.safeParse(env);
const problems = (env) => {
  const result = parse(env);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
};

const KEY = 'brevo-secret-key-value';
const TOKEN = 'brevo-webhook-token-0123456789';
const TRANSACTIONAL = {
  BREVO_API_KEY: KEY,
  BREVO_WEBHOOK_TOKEN: TOKEN,
  BREVO_TRANSACTIONAL: 'on',
};
const ANNOUNCEMENTS = {
  BREVO_API_KEY: KEY,
  BREVO_WEBHOOK_TOKEN: TOKEN,
  ANNOUNCEMENT_FROM_ADDRESS: 'news@usetipme.xyz',
};
const PRODUCTION = { NODE_ENV: 'production', DEPLOYMENT_MODE: 'production' };

const code = {
  reference: '01a18300-0000-7000-8000-00000000c0f2',
  to: 'ada@example.com',
  from: { address: 'security@mail.usetipme.xyz', name: 'TipMe Security' },
  subject: 'Your TipMe code',
  text: '123456',
  html: '<p>123456</p>',
  headers: {},
  tracking: false,
};

const recorder = () => {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json(
        { messageId: '<t1@smtp-relay.mailin.fr>' },
        {
          status: 201,
        },
      );
    },
  };
};

test('without a fixed sender, Brevo sends from the mail’s own sender', async () => {
  const { requests, fetchImpl } = recorder();
  const brevo = createBrevoProvider({
    apiKey: 'brevo-placeholder-test',
    apiBase: 'https://api.brevo.example',
    webhookToken: TOKEN,
    sandbox: false,
    fetchImpl,
  });
  await brevo.send(code);
  assert.deepEqual(requests[0].body.sender, {
    email: 'security@mail.usetipme.xyz',
    name: 'TipMe Security',
  });
  assert.equal(
    requests[0].body.headers['X-Mailin-custom'],
    `tipme_ref:${code.reference}`,
  );
});

test('off by default: the Brevo key alone never makes Brevo a provider for codes', () => {
  const config = parse({ ...ANNOUNCEMENTS }).data;
  assert.equal(config.BREVO_TRANSACTIONAL, false);
  assert.equal(config.BREVO_TRANSACTIONAL_SANDBOX, false);
  assert.ok(!configuredMailProviderNames(config).has('brevo'));
  assert.deepEqual(
    problems({ ...ANNOUNCEMENTS, MAIL_DEFAULT_PROVIDER: 'brevo' }),
    ['MAIL_DEFAULT_PROVIDER'],
  );
});

test('BREVO_TRANSACTIONAL=on with the key and webhook token makes Brevo a provider', () => {
  const config = parse({ ...TRANSACTIONAL }).data;
  assert.equal(config.BREVO_TRANSACTIONAL, true);
  assert.deepEqual([...configuredMailProviderNames(config)].sort(), [
    'brevo',
    'mock',
  ]);
  // It may be the server default too, and needs no announcement sender.
  assert.deepEqual(
    problems({ ...TRANSACTIONAL, MAIL_DEFAULT_PROVIDER: 'brevo' }),
    [],
  );
  assert.deepEqual(
    [
      ...configuredMailProviderNames({
        ...config,
        ...PRODUCTION,
      }),
    ],
    ['brevo'],
  );
});

test('all or none: switching it on names whichever Brevo key is missing, never a secret', () => {
  assert.deepEqual(problems({ BREVO_TRANSACTIONAL: 'on' }).sort(), [
    'BREVO_API_KEY',
    'BREVO_WEBHOOK_TOKEN',
  ]);
  assert.deepEqual(
    problems({ BREVO_TRANSACTIONAL: 'on', BREVO_API_KEY: KEY }),
    ['BREVO_WEBHOOK_TOKEN'],
  );
  // The announcement key with its sender still pass unchanged.
  assert.deepEqual(problems({ ...ANNOUNCEMENTS }), []);
  // A key with neither use is still half an announcement setup.
  assert.deepEqual(problems({ BREVO_API_KEY: KEY }), [
    'ANNOUNCEMENT_FROM_ADDRESS',
  ]);
  const result = parse({ BREVO_TRANSACTIONAL: 'on', BREVO_API_KEY: KEY });
  assert.ok(!JSON.stringify(result.error.issues).includes(KEY));
  assert.ok(problems({ BREVO_TRANSACTIONAL: 'maybe' }).length > 0);
});

test('the transactional instance sends each type from its own sender, not the announcement one', async () => {
  const { requests, fetchImpl } = recorder();
  const config = parse({ ...ANNOUNCEMENTS, ...TRANSACTIONAL }).data;
  const brevo = configuredMailProviders(config, async () => {}, {
    fetchImpl,
  }).get('brevo');
  assert.equal(brevo.name, 'brevo');
  assert.deepEqual(await brevo.send(code), {
    providerMessageId: '<t1@smtp-relay.mailin.fr>',
  });
  assert.equal(requests[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.deepEqual(requests[0].body.sender, {
    email: 'security@mail.usetipme.xyz',
    name: 'TipMe Security',
  });
});

test('the transactional instance obeys its own sandbox flag, never the announcement one', async () => {
  const sink = async () => {};
  const send = async (env) => {
    const { requests, fetchImpl } = recorder();
    const config = parse(env).data;
    const brevo = configuredMailProviders(config, sink, { fetchImpl }).get(
      'brevo',
    );
    await brevo.send(code);
    return {
      header: requests[0].body.headers['X-Sib-Sandbox'] ?? null,
      status: await brevo.status(),
      announcement: await announcementMailProvider(config, sink).status(),
    };
  };
  // Staging keeps announcements in the sandbox while codes really go out.
  const staging = await send({
    ...ANNOUNCEMENTS,
    ...TRANSACTIONAL,
    BREVO_SANDBOX: 'on',
  });
  assert.equal(staging.header, null);
  assert.equal(staging.status.sandbox, false);
  assert.equal(staging.announcement.sandbox, true);
  const dropped = await send({
    ...TRANSACTIONAL,
    BREVO_TRANSACTIONAL_SANDBOX: 'on',
  });
  assert.equal(dropped.header, 'drop');
  assert.equal(dropped.status.sandbox, true);
});

test('the transactional instance accepts Brevo’s webhooks with the shared token', () => {
  const config = parse({ ...TRANSACTIONAL }).data;
  const brevo = configuredMailProviders(config, async () => {}).get('brevo');
  const result = brevo.verifyWebhook(
    Buffer.from(
      JSON.stringify({
        event: 'delivered',
        email: 'ada@example.com',
        'message-id': '<t1@smtp-relay.mailin.fr>',
        ts_event: 1_794_650_000,
        'X-Mailin-custom': `tipme_ref:${code.reference}`,
      }),
    ),
    { authorization: `Bearer ${TOKEN}` },
    new Date(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.events[0].kind, 'delivered');
  assert.equal(result.events[0].reference, code.reference);
});

// Fix round 1 (review I1): Brevo can't turn link rewriting off per email. Where mail must not be
// tracked (security mail), the adapter asks for no open pixel and no per-contact tracking, which
// Brevo honours on plans that support it, and the codes instance warns staff on its card.
test('untracked mail asks Brevo for no pixel and no contact tracking; tracked mail does not', async () => {
  const { requests, fetchImpl } = recorder();
  const config = parse({ ...TRANSACTIONAL }).data;
  const brevo = configuredMailProviders(config, async () => {}, {
    fetchImpl,
  }).get('brevo');
  await brevo.send(code);
  assert.deepEqual(requests[0].body.to, [
    {
      email: 'ada@example.com',
      removeTrackingPixel: true,
      contactPixelTrackingConsent: false,
    },
  ]);
  await brevo.send({ ...code, tracking: true });
  assert.deepEqual(requests[1].body.to, [{ email: 'ada@example.com' }]);
});

test('the codes instance warns on its card that Brevo may still rewrite links', async () => {
  const sink = async () => {};
  const config = parse({ ...ANNOUNCEMENTS, ...TRANSACTIONAL }).data;
  const status = await configuredMailProviders(config, sink)
    .get('brevo')
    .status();
  assert.equal(status.sandbox, false);
  assert.match(status.detail, /click tracking/i);
  assert.match(status.detail, /Brevo account/);
  // The announcement instance's status is unchanged.
  assert.deepEqual(await announcementMailProvider(config, sink).status(), {
    sandbox: false,
    detail: null,
  });
  const dropped = parse({
    ...TRANSACTIONAL,
    BREVO_TRANSACTIONAL_SANDBOX: 'on',
  }).data;
  const sandboxed = await configuredMailProviders(dropped, sink)
    .get('brevo')
    .status();
  assert.equal(sandboxed.sandbox, true);
  assert.match(sandboxed.detail, /Sandbox/);
});

test('the codes instance keeps the reply-to and one-click unsubscribe headers', async () => {
  const { requests, fetchImpl } = recorder();
  const config = parse({ ...TRANSACTIONAL }).data;
  const brevo = configuredMailProviders(config, async () => {}, {
    fetchImpl,
  }).get('brevo');
  await brevo.send({
    ...code,
    replyTo: 'support@usetipme.xyz',
    headers: {
      'List-Unsubscribe': '<https://api.usetipme.xyz/v1/mail/unsubscribe?t=a>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  assert.deepEqual(requests[0].body.replyTo, { email: 'support@usetipme.xyz' });
  assert.deepEqual(requests[0].body.headers, {
    'List-Unsubscribe': '<https://api.usetipme.xyz/v1/mail/unsubscribe?t=a>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Mailin-custom': `tipme_ref:${code.reference}`,
  });
});

// Review M1: in production, codes sent with Brevo's sandbox on would be marked sent and dropped.
test('production refuses BREVO_TRANSACTIONAL_SANDBOX=on', () => {
  const production = z
    .object({
      NODE_ENV: z.string(),
      DEPLOYMENT_MODE: z.string(),
      ...mailSettingsShape,
    })
    .superRefine((config, context) => checkMailSettings(config, context));
  const issues = (env) => {
    const result = production.safeParse(env);
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join('.'));
  };
  const live = {
    ...TRANSACTIONAL,
    ...PRODUCTION,
    MAIL_DEFAULT_PROVIDER: 'brevo',
  };
  assert.deepEqual(issues(live), []);
  assert.deepEqual(issues({ ...live, BREVO_TRANSACTIONAL_SANDBOX: 'on' }), [
    'BREVO_TRANSACTIONAL_SANDBOX',
  ]);
  // A preview copy is not production.
  assert.deepEqual(
    issues({
      ...live,
      DEPLOYMENT_MODE: 'preview',
      BREVO_TRANSACTIONAL_SANDBOX: 'on',
    }),
    [],
  );
});
