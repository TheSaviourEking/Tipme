import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBrevoProvider,
  createMailHealth,
  createSesProvider,
  createZeptoMailProvider,
  mailProviderChain,
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
  memoryMailHealthStore,
  sendFailureOf,
} from '../dist/index.js';
import { runHealthStoreCases } from './fixtures/health-store-cases.mjs';

// Automatic failover between email providers (owner, 23 Nov 2026). The backup is whichever
// configured provider isn't active; a definite failure moves the same mail on at once and counts
// toward a breaker shared by every process; a manual choice always wins. Without a fallback list
// nothing changes.

const base = {
  pinned: null,
  override: null,
  active: 'zeptomail',
  defaultProvider: 'zeptomail',
  configured: new Set(['zeptomail', 'brevo', 'ses', 'mock']),
  to: 'ada@gmail.com',
  pretendDomains: [],
  fallbacks: [],
  production: false,
};
const chain = (extra = {}) => mailProviderChain({ ...base, ...extra });

test('with no fallback configured, the chain is the one provider routing picks today', () => {
  assert.deepEqual(chain(), ['zeptomail']);
  assert.deepEqual(chain({ active: 'ses' }), ['ses']);
  assert.deepEqual(chain({ active: 'brevo' }), ['brevo']);
});

test('the backup is whichever provider of the pair is not active', () => {
  assert.deepEqual(chain({ fallbacks: ['brevo'] }), ['zeptomail', 'brevo']);
  // Staff made Brevo active in ops: ZeptoMail (the default) becomes the backup.
  assert.deepEqual(chain({ fallbacks: ['brevo'], active: 'brevo' }), [
    'brevo',
    'zeptomail',
  ]);
});

test('the fallback list is followed in order, skipping repeats and the unconfigured', () => {
  assert.deepEqual(chain({ fallbacks: ['brevo', 'ses'] }), [
    'zeptomail',
    'brevo',
    'ses',
  ]);
  assert.deepEqual(chain({ fallbacks: ['zeptomail', 'brevo'] }), [
    'zeptomail',
    'brevo',
  ]);
  assert.deepEqual(
    chain({
      fallbacks: ['brevo', 'ses'],
      configured: new Set(['zeptomail', 'ses']),
    }),
    ['zeptomail', 'ses'],
  );
});

test('production never falls back to the pretend provider', () => {
  assert.deepEqual(chain({ fallbacks: ['mock', 'brevo'], production: true }), [
    'zeptomail',
    'brevo',
  ]);
  // Outside production a developer may list it.
  assert.deepEqual(chain({ fallbacks: ['mock'] }), ['zeptomail', 'mock']);
});

test('a provider test, a per-person override, the pretend inbox and a fixed provider never fail over', () => {
  assert.deepEqual(chain({ fallbacks: ['brevo'], pinned: 'ses' }), ['ses']);
  assert.deepEqual(chain({ fallbacks: ['brevo'], override: 'ses' }), ['ses']);
  assert.deepEqual(chain({ fallbacks: ['brevo'], to: 'r@x.example' }), [
    'mock',
  ]);
  assert.deepEqual(chain({ fallbacks: ['brevo'], fixed: true }), ['zeptomail']);
});

test('a resend starts after the provider that sent the last code', () => {
  assert.deepEqual(chain({ fallbacks: ['brevo', 'ses'], after: 'zeptomail' }), [
    'brevo',
    'ses',
    'zeptomail',
  ]);
  assert.deepEqual(chain({ fallbacks: ['brevo', 'ses'], after: 'brevo' }), [
    'ses',
    'zeptomail',
    'brevo',
  ]);
  // Not in the chain, or nothing to rotate to: unchanged.
  assert.deepEqual(chain({ fallbacks: ['brevo'], after: 'ses' }), [
    'zeptomail',
    'brevo',
  ]);
  assert.deepEqual(chain({ after: 'zeptomail' }), ['zeptomail']);
  assert.deepEqual(
    chain({ fallbacks: ['brevo'], after: 'zeptomail', fixed: true }),
    ['zeptomail'],
  );
});

test('only a definite "not sent" moves a mail on; a refusal of the mail itself never does', () => {
  assert.deepEqual(sendFailureOf(new MailTemporaryError('http_503')), {
    kind: 'definite',
    code: 'http_503',
  });
  assert.equal(
    sendFailureOf(new MailTemporaryError('timeout')).kind,
    'definite',
  );
  assert.equal(
    sendFailureOf(new MailTemporaryError('network')).kind,
    'definite',
  );
  assert.equal(
    sendFailureOf(new MailQuotaError('not_enough_credits')).kind,
    'definite',
  );
  assert.equal(
    sendFailureOf(new MailRejectedError('http_401', { providerFault: true }))
      .kind,
    'definite',
  );
  assert.equal(sendFailureOf(new MailRejectedError('SM_113')).kind, 'rejected');
  // Accepted perhaps: a 2xx without a message id, or an error nobody classified.
  assert.equal(
    sendFailureOf(new MailTemporaryError('no_request_id', { ambiguous: true }))
      .kind,
    'ambiguous',
  );
  assert.equal(sendFailureOf(new Error('boom')).kind, 'ambiguous');
});

const MAIL = {
  reference: 'r',
  to: 'a@gmail.com',
  from: { address: 'h@mail.usetipme.xyz', name: 'T' },
  subject: 's',
  text: 't',
  html: 'h',
  headers: {},
  tracking: false,
};

async function failureOf(provider) {
  try {
    await provider.send(MAIL);
  } catch (error) {
    return sendFailureOf(error);
  }
  assert.fail('expected the send to fail');
}

test('ZeptoMail: its key, IP, account and sender domain are about ZeptoMail, a bad field is about the mail', async () => {
  const zepto = (status, code) =>
    createZeptoMailProvider({
      apiKey: 'k',
      apiBase: 'https://api.zeptomail.test',
      webhookKey: 'webhook-key-1234',
      fetchImpl: async () =>
        Response.json(
          { error: { code: 'TM_4001', details: [{ code }] } },
          { status },
        ),
    });
  // Documented sub-codes (read 23 Nov 2026): SERR_157 invalid key, SERR_156 IP not allowed,
  // AE_101 account blocked, SM_128 account not yet reviewed, SM_111 sender domain not verified.
  for (const code of ['SERR_157', 'SERR_156', 'AE_101', 'SM_128', 'SM_111'])
    assert.equal((await failureOf(zepto(400, code))).kind, 'definite', code);
  for (const code of ['SM_113', 'GE_102', 'SM_101'])
    assert.equal((await failureOf(zepto(400, code))).kind, 'rejected', code);
  assert.equal((await failureOf(zepto(401, 'XX'))).kind, 'definite');
  assert.equal((await failureOf(zepto(403, 'XX'))).kind, 'definite');
  assert.equal((await failureOf(zepto(503, 'XX'))).kind, 'definite');
  // Credits: a pause for ZeptoMail, and definite for failover.
  assert.equal((await failureOf(zepto(400, 'LE_102'))).kind, 'definite');
});

test('ZeptoMail and SES: a success without an id may hide an accepted mail', async () => {
  const zepto = createZeptoMailProvider({
    apiKey: 'k',
    apiBase: 'https://api.zeptomail.test',
    webhookKey: 'webhook-key-1234',
    fetchImpl: async () => Response.json({ data: [] }, { status: 201 }),
  });
  assert.equal((await failureOf(zepto)).kind, 'ambiguous');
  const ses = createSesProvider({
    region: 'eu-north-1',
    configurationSet: 'a',
    configurationSetUntracked: 'b',
    topicArn: 'arn:aws:sns:eu-north-1:123456789012:t',
    client: { send: async () => ({}) },
  });
  assert.equal((await failureOf(ses)).kind, 'ambiguous');
});

test('SES: an unverified sender domain or a suspended account is about SES', async () => {
  const ses = (name) =>
    createSesProvider({
      region: 'eu-north-1',
      configurationSet: 'a',
      configurationSetUntracked: 'b',
      topicArn: 'arn:aws:sns:eu-north-1:123456789012:t',
      client: {
        send: async () => {
          const error = new Error('x');
          error.name = name;
          throw error;
        },
      },
    });
  assert.equal(
    (await failureOf(ses('MailFromDomainNotVerifiedException'))).kind,
    'definite',
  );
  assert.equal(
    (await failureOf(ses('AccountSuspendedException'))).kind,
    'definite',
  );
  assert.equal((await failureOf(ses('MessageRejected'))).kind, 'rejected');
});

test('Brevo: a refused key or account is about Brevo; out of credits is definite; a bad address is not', async () => {
  const brevo = (status, body) =>
    createBrevoProvider({
      apiKey: 'k',
      apiBase: 'https://api.brevo.test',
      fetchImpl: async () => Response.json(body, { status }),
    });
  assert.equal(
    (await failureOf(brevo(401, { code: 'unauthorized' }))).kind,
    'definite',
  );
  assert.equal(
    (await failureOf(brevo(403, { code: 'permission_denied' }))).kind,
    'definite',
  );
  assert.equal(
    (await failureOf(brevo(400, { code: 'account_under_validation' }))).kind,
    'definite',
  );
  assert.equal(
    (await failureOf(brevo(402, { code: 'not_enough_credits' }))).kind,
    'definite',
  );
  assert.equal(
    (await failureOf(brevo(400, { code: 'invalid_parameter' }))).kind,
    'rejected',
  );
  assert.equal((await failureOf(brevo(201, {}))).kind, 'ambiguous');
});

// The breaker. The same cases run against the Redis store in the database integration tests.
runHealthStoreCases(test, (settings) => memoryMailHealthStore(settings));

/** A clock tests move by hand. */
function clock(start = Date.parse('2026-11-23T10:00:00Z')) {
  let at = start;
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    },
  };
}

const SETTINGS = {
  threshold: 3,
  windowMs: 300_000,
  restMs: 900_000,
  trialCodes: 3,
};

test('three send failures in five minutes trip with a reason staff can read, and alert once', async () => {
  const c = clock();
  const changes = [];
  const h = createMailHealth({
    store: memoryMailHealthStore(SETTINGS),
    settings: SETTINGS,
    onChange: async (change) => {
      changes.push(change);
    },
    clock: c.now,
  });
  await h.failed('zeptomail', 'http_503');
  await h.failed('zeptomail', 'timeout');
  await h.failed('zeptomail', 'http_503');
  await h.failed('zeptomail', 'http_503');
  const view = (await h.snapshot(['zeptomail'])).get('zeptomail');
  assert.equal(view.state, 'resting');
  assert.equal(view.kind, 'send');
  assert.equal(view.reason, '3 send failures in 5 min (last: http_503)');
  assert.equal(view.until.toISOString(), '2026-11-23T10:15:00.000Z');
  assert.deepEqual(
    changes.map((x) => [x.provider, x.change, x.until?.toISOString()]),
    [['zeptomail', 'tripped', '2026-11-23T10:15:00.000Z']],
  );
  // After the rest, one probe; its success restores the provider and staff hear it.
  c.advance(900_000);
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'trial',
  );
  assert.equal(await h.claim('zeptomail', { code: false }), true);
  assert.equal(await h.claim('zeptomail', { code: false }), false);
  await h.succeeded('zeptomail');
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'healthy',
  );
  assert.deepEqual(
    changes.map((x) => x.change),
    ['tripped', 'recovered'],
  );
});

test('unused codes trip with their own reason; the trial codes decide', async () => {
  const c = clock();
  const changes = [];
  const h = createMailHealth({
    store: memoryMailHealthStore(SETTINGS),
    settings: SETTINGS,
    onChange: async (change) => {
      changes.push(change);
    },
    clock: c.now,
  });
  await h.tripCodes('zeptomail', '4 of 6 codes unused in 10 min');
  const view = (await h.snapshot(['zeptomail'])).get('zeptomail');
  assert.equal(view.state, 'resting');
  assert.equal(view.kind, 'codes');
  assert.equal(view.reason, '4 of 6 codes unused in 10 min');
  c.advance(900_000);
  // Only codes are trial traffic for a codes trip, and only the next three.
  assert.equal(await h.claim('zeptomail', { code: false }), false);
  assert.equal(await h.claim('zeptomail', { code: true }), true);
  assert.equal(await h.claim('zeptomail', { code: true }), true);
  assert.equal(await h.claim('zeptomail', { code: true }), true);
  assert.equal(await h.claim('zeptomail', { code: true }), false);
  // A successful send proves nothing about delivery: still on trial.
  await h.succeeded('zeptomail');
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'trial',
  );
  await h.restoreCodes('zeptomail');
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'healthy',
  );
  assert.deepEqual(
    changes.map((x) => x.change),
    ['tripped', 'recovered'],
  );
});

test('staff can clear a tripped provider by hand', async () => {
  const c = clock();
  const h = createMailHealth({
    store: memoryMailHealthStore(SETTINGS),
    settings: SETTINGS,
    clock: c.now,
  });
  await h.tripCodes('brevo', 'x');
  assert.equal(await h.clear('brevo'), true);
  const view = (await h.snapshot(['brevo'])).get('brevo');
  assert.equal(view.state, 'healthy');
  assert.equal(view.recoveredAt.toISOString(), c.now().toISOString());
  assert.equal(await h.clear('brevo'), false, 'nothing to clear');
});

test('a store that is down never stops mail: every provider reads healthy, nothing throws', async () => {
  const c = clock();
  const down = async () => {
    throw new Error('redis down');
  };
  const broken = {
    fail: down,
    trip: down,
    succeed: down,
    claim: down,
    clear: down,
    read: down,
  };
  const logged = [];
  const h = createMailHealth({
    store: broken,
    settings: SETTINGS,
    clock: c.now,
    log: (entry) => logged.push(entry.event),
  });
  await h.failed('zeptomail', 'x');
  await h.succeeded('zeptomail');
  await h.tripCodes('zeptomail', 'x');
  await h.restoreCodes('zeptomail');
  assert.equal(await h.claim('zeptomail', { code: true }), false);
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'healthy',
  );
  assert.ok(logged.includes('mail.health_unavailable'));
  // Ops asks before a clear and must hear the store is down, not "healthy".
  await assert.rejects(h.inspect('zeptomail'));
});

test('an alert that fails never stops mail', async () => {
  const c = clock();
  const logged = [];
  const h = createMailHealth({
    store: memoryMailHealthStore(SETTINGS),
    settings: SETTINGS,
    clock: c.now,
    onChange: async () => {
      throw new Error('webhook down');
    },
    log: (entry) => logged.push(entry.event),
  });
  await h.tripCodes('zeptomail', 'x');
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').state,
    'resting',
  );
  assert.ok(logged.includes('mail.health_alert_failed'));
});

test('the failover group is the default, then the fallbacks, configured ones only, never the pretend provider in production', async () => {
  const { mailFailoverGroup } = await import('../dist/index.js');
  const configured = new Set(['zeptomail', 'brevo', 'mock']);
  assert.deepEqual(
    mailFailoverGroup('zeptomail', ['brevo'], configured, true),
    ['zeptomail', 'brevo'],
  );
  assert.deepEqual(
    mailFailoverGroup('zeptomail', ['mock', 'brevo'], configured, true),
    ['zeptomail', 'brevo'],
  );
  assert.deepEqual(mailFailoverGroup('zeptomail', ['ses'], configured, false), [
    'zeptomail',
  ]);
});

test('the live provider is the first healthy one, the active one first; all resting, the active one', async () => {
  const { liveMailProvider } = await import('../dist/index.js');
  const view = (state) => ({ state });
  const views = new Map([
    ['zeptomail', view('resting')],
    ['brevo', view('healthy')],
  ]);
  assert.equal(liveMailProvider(['zeptomail', 'brevo'], views), 'brevo');
  assert.equal(
    liveMailProvider(
      ['zeptomail', 'brevo'],
      new Map([
        ['zeptomail', view('trial')],
        ['brevo', view('healthy')],
      ]),
    ),
    'brevo',
  );
  assert.equal(
    liveMailProvider(
      ['zeptomail', 'brevo'],
      new Map([
        ['zeptomail', view('resting')],
        ['brevo', view('resting')],
      ]),
    ),
    'zeptomail',
  );
  assert.equal(
    liveMailProvider(['zeptomail', 'brevo'], new Map()),
    'zeptomail',
  );
});

test('a failed probe tells staff it was the trial send that failed', async () => {
  const c = clock();
  const h = createMailHealth({
    store: memoryMailHealthStore(SETTINGS),
    settings: SETTINGS,
    clock: c.now,
  });
  for (let i = 0; i < 3; i++) await h.failed('zeptomail', 'http_503');
  c.advance(900_000);
  assert.equal(await h.claim('zeptomail', { code: false }), true);
  await h.failed('zeptomail', 'http_500');
  assert.equal(
    (await h.snapshot(['zeptomail'])).get('zeptomail').reason,
    'trial send failed (http_500)',
  );
});
