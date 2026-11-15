import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  BODY_CAP_BYTES,
  ChangelogRequestError,
  draftPayload,
  essentialBody,
  firstParagraph,
  forUsersSection,
  post,
  sign,
} from './changelog-client.mjs';

// Changelog plan, Task 3.1. The fixture is pinned in apps/api/test/changelog-signature.test.mjs too:
// the same secret, timestamp and body must give the same hex on both sides.
const FIXTURE = {
  secret: 'changelog-fixture-secret-0123456789abcdef',
  timestamp: '1762430400',
  body: '{"environment":"production"}',
  hex: '83bc073c964544e44d06d1656e312492bfa12f9b041410a6ff4007e9894267ef',
};

let server;
let base;
let answers = [];
const received = [];

before(async () => {
  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url,
        headers: request.headers,
        raw: Buffer.concat(chunks),
      });
      const next = answers.shift() ?? { status: 200, body: { data: {} } };
      if (next.drop) {
        request.socket.destroy();
        return;
      }
      response.writeHead(next.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(next.body));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const reset = (...next) => {
  answers = next;
  received.length = 0;
};

test('the signature matches the pinned fixture the API checks', () => {
  const signed = sign(
    FIXTURE.secret,
    FIXTURE.body,
    Number(FIXTURE.timestamp) * 1000,
  );
  assert.deepEqual(signed, {
    timestamp: FIXTURE.timestamp,
    signature: `sha256=${FIXTURE.hex}`,
  });
  // Buffers and strings sign the same bytes.
  assert.deepEqual(
    sign(
      FIXTURE.secret,
      Buffer.from(FIXTURE.body),
      Number(FIXTURE.timestamp) * 1000,
    ),
    signed,
  );
  // The API test pins the same hex.
  const apiTest = readFileSync(
    new URL('../apps/api/test/changelog-signature.test.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(apiTest.includes(FIXTURE.hex), 'the API test pins another hex');
  assert.ok(apiTest.includes(FIXTURE.secret));
});

test('post signs the exact bytes it sends, under /v1/webhooks/changelog/', async () => {
  reset({ status: 200, body: { data: { created: true } } });
  const answer = await post(
    base,
    'drafts',
    { number: 1, title: 'ünïcode' },
    FIXTURE.secret,
  );
  assert.deepEqual(answer, { data: { created: true } });
  const [request] = received;
  assert.equal(request.path, '/v1/webhooks/changelog/drafts');
  assert.equal(request.headers['content-type'], 'application/json');
  const expected = sign(
    FIXTURE.secret,
    request.raw,
    Number(request.headers['x-tipme-timestamp']) * 1000,
  );
  assert.equal(request.headers['x-tipme-signature'], expected.signature);
  assert.deepEqual(JSON.parse(request.raw.toString('utf8')), {
    number: 1,
    title: 'ünïcode',
  });
  // Unix seconds, close to now.
  assert.ok(
    Math.abs(Number(request.headers['x-tipme-timestamp']) - Date.now() / 1000) <
      5,
  );
  // A trailing slash on the API URL makes no double slash.
  reset({ status: 200, body: { data: [] } });
  await post(`${base}/`, 'pending', {}, FIXTURE.secret);
  assert.equal(received[0].path, '/v1/webhooks/changelog/pending');
});

test('a 401 is "signature refused" and is not retried', async () => {
  reset({
    status: 401,
    body: { error: { code: 'CHANGELOG_SIGNATURE_INVALID' } },
  });
  await assert.rejects(
    post(base, 'pending', {}, FIXTURE.secret, { retryDelayMs: 1 }),
    (error) =>
      error instanceof ChangelogRequestError &&
      error.status === 401 &&
      /signature refused/.test(error.message) &&
      !error.message.includes(FIXTURE.secret),
  );
  assert.equal(received.length, 1);
});

test('a 5xx is retried once, then succeeds', async () => {
  reset(
    { status: 503, body: {} },
    { status: 200, body: { data: { marked: [1] } } },
  );
  assert.deepEqual(
    await post(base, 'releases', {}, FIXTURE.secret, { retryDelayMs: 1 }),
    { data: { marked: [1] } },
  );
  assert.equal(received.length, 2);
});

test('two 5xx in a row fail after one retry', async () => {
  reset({ status: 500, body: {} }, { status: 502, body: {} });
  await assert.rejects(
    post(base, 'releases', {}, FIXTURE.secret, { retryDelayMs: 1 }),
    (error) => error instanceof ChangelogRequestError && error.status === 502,
  );
  assert.equal(received.length, 2);
});

test('a network error is retried once; a 400 is not', async () => {
  reset({ drop: true }, { status: 200, body: { data: [] } });
  assert.deepEqual(
    await post(base, 'pending', {}, FIXTURE.secret, { retryDelayMs: 1 }),
    { data: [] },
  );
  assert.equal(received.length, 2);

  reset({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } });
  await assert.rejects(
    post(base, 'pending', {}, FIXTURE.secret, { retryDelayMs: 1 }),
    (error) => error.status === 400 && /400/.test(error.message),
  );
  assert.equal(received.length, 1);
});

test('a request that takes too long times out and is retried once', async () => {
  // Nobody answers on this server: both tries time out.
  const silent = createServer(() => {});
  await new Promise((done) => silent.listen(0, '127.0.0.1', done));
  try {
    const started = Date.now();
    await assert.rejects(
      post(
        `http://127.0.0.1:${silent.address().port}`,
        'pending',
        {},
        FIXTURE.secret,
        { timeoutMs: 100, retryDelayMs: 1 },
      ),
      (error) =>
        error instanceof ChangelogRequestError &&
        /timed out|network/i.test(error.message),
    );
    assert.ok(Date.now() - started < 5000);
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
});

test('draftPayload keeps a body that fits, and turns an empty body into null', () => {
  const pr = {
    number: 7,
    title: 'feat: x',
    body: 'Why.\n\n## For users\nYou can now…',
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-11-05T10:00:00Z',
  };
  assert.deepEqual(draftPayload(pr), pr);
  assert.equal(draftPayload({ ...pr, body: '' }).body, null);
  assert.equal(draftPayload({ ...pr, body: null }).body, null);
});

test('draftPayload cuts a long body by UTF-8 bytes, under the 128 KiB cap and the 65 536 limit', () => {
  const pr = {
    number: 7,
    title: 'feat: x',
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-11-05T10:00:00Z',
  };
  const cases = {
    // 65 536 characters, but 4 bytes each in UTF-8: 256 KiB as sent.
    emoji: '😀'.repeat(40_000),
    // 3 bytes each.
    naira: '₦'.repeat(65_536),
    // Escaped to two bytes each in JSON.
    quotes: '"'.repeat(65_536),
    // Escaped to six bytes each (\u0001).
    control: '\u0001'.repeat(65_536),
    // Plain ASCII over the character limit.
    ascii: 'a'.repeat(70_000),
  };
  for (const [name, body] of Object.entries(cases)) {
    const payload = draftPayload({ ...pr, body });
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes <= BODY_CAP_BYTES, `${name}: ${bytes} bytes`);
    assert.ok(payload.body.length <= 65_536, `${name}: ${payload.body.length}`);
    assert.ok(body.startsWith(payload.body), `${name}: not a prefix`);
    // Never half a surrogate pair.
    assert.ok(payload.body.isWellFormed(), `${name}: split a character`);
    // It keeps as much as fits: one more character would break a limit.
    assert.ok(
      payload.body.length >= 65_535 || bytes > BODY_CAP_BYTES - 12,
      `${name}: cut too much (${payload.body.length} characters, ${bytes} bytes)`,
    );
  }
  assert.equal(BODY_CAP_BYTES, 128 * 1024);
});

test('draftPayload cuts a title to 256 characters without splitting one', () => {
  const payload = draftPayload({
    number: 7,
    title: `a${'😀'.repeat(300)}`,
    body: null,
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-11-05T10:00:00Z',
  });
  assert.ok(payload.title.length <= 256);
  assert.ok(payload.title.isWellFormed());
});

test('the client limits match the contracts', () => {
  const source = readFileSync(
    new URL('../packages/contracts/src/changelog.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /CHANGELOG_TITLE_LIMIT = 256;/);
  assert.match(source, /CHANGELOG_BODY_LIMIT = 65_536;/);
  const middleware = readFileSync(
    new URL(
      '../apps/api/src/changelog/changelog-body.middleware.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(middleware, /128 \* 1024/);
});

// A big PR's body, shaped like #226's (about 31 000 characters): template headings, a comment,
// long notes and test output, and a "For users" section in the middle.
const BIG_BODY = [
  '## Summary',
  '<!-- Say what changed and why. -->',
  'Page Studio phases 2–4: the document model, the renderer and the API, all behind page_studio.',
  'Owners can design their page in the studio.',
  '',
  '## Notes',
  ...Array.from(
    { length: 300 },
    (_, i) => `- note ${i}: ${'détail '.repeat(12)}`,
  ),
  '',
  '## For users',
  '<!-- One or two sentences a user would understand. -->',
  'You can now design your page in Page Studio:',
  'colours, fonts and layout, with a live preview.',
  '',
  '## Tests',
  '```',
  ...Array.from({ length: 200 }, (_, i) => `ok ${i} - something passes ₦`),
  '```',
].join('\n');

test('essentialBody keeps only the first paragraph and the "For users" section', () => {
  assert.ok(BIG_BODY.length > 30_000, `${BIG_BODY.length}`);
  const short = essentialBody(BIG_BODY);
  assert.equal(
    short,
    'Page Studio phases 2–4: the document model, the renderer and the API, all behind page_studio. Owners can design their page in the studio.\n\n## For users\nYou can now design your page in Page Studio: colours, fonts and layout, with a live preview.',
  );
  // No "For users" section: the paragraph alone. Nothing readable: null.
  assert.equal(essentialBody('Why.\n\n## Notes\nlong'), 'Why.');
  assert.equal(essentialBody('## Summary\n<!-- hint -->\n'), null);
  assert.equal(essentialBody(''), null);
  assert.equal(essentialBody(null), null);
});

test('draftPayload sends a big body as just the parts TipMe reads, signed over those bytes', async () => {
  const payload = draftPayload({
    number: 226,
    title: 'Page Studio phases 2–4',
    body: BIG_BODY,
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-11-15T00:11:00Z',
  });
  assert.equal(payload.body, essentialBody(BIG_BODY));
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024);
  reset({ status: 200, body: { data: { created: true } } });
  await post(base, 'drafts', payload, FIXTURE.secret);
  const [request] = received;
  assert.deepEqual(JSON.parse(request.raw.toString('utf8')), payload);
  const expected = sign(
    FIXTURE.secret,
    request.raw,
    Number(request.headers['x-tipme-timestamp']) * 1000,
  );
  assert.equal(request.headers['x-tipme-signature'], expected.signature);
});

test("essentialBody reads the same as the full body, by the contracts' own rules", async () => {
  const contracts = await import('../packages/contracts/dist/index.js');
  const bodies = [
    BIG_BODY,
    'Why.\n\n## For users\nYou can pin a supporter note.',
    '## For users\nOnly this.',
    '### Summary\n\nFirst line\nsecond line\n\n#### FOR USERS  \n  You can,\n\n  now.\n## Next',
    'Text <!-- unclosed comment\n## For users\nhidden',
    'Lead <!-- a --> text\r\n\r\n# for users\r\nWindows lines\r\n',
    '<!<!--x-->-- odd comment\n\n## For users\nyes',
    '#hashtag first\n\n## For users\n#hashtag too',
    'No sections at all, just one long line',
  ];
  for (const body of bodies) {
    assert.equal(firstParagraph(body), contracts.firstParagraph(body), body);
    assert.equal(forUsersSection(body), contracts.forUsersSection(body), body);
    for (const title of ['feat: x', 'a'.repeat(2000)]) {
      assert.deepEqual(
        contracts.draftFromPullRequest({ title, body: essentialBody(body) }),
        contracts.draftFromPullRequest({ title, body }),
        body,
      );
    }
  }
});
