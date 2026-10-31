import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { browserHeaders, startStack, uniquePrefix } from './helpers.mjs';

// Over real HTTP, on a test copy: the release check's staff address (and .example sign-ups) can
// get a code on every deploy, while a real address keeps the limit of 3 an hour.

let stack;
let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RELEASE_KIND: 'test',
      MAIL_PRETEND_DOMAINS: 'release-check.usetipme.xyz',
    },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const ask = (email) =>
  fetch(`${stack.api}/v1/auth/code`, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ email }),
  });
const codesFor = async (email) =>
  (
    await database.pool.query(
      'SELECT count(*)::int AS n FROM email_codes WHERE email = $1',
      [email],
    )
  ).rows[0].n;

test('the release staff address and .example sign-ups get a code every time', async () => {
  for (const email of [
    'release@release-check.usetipme.xyz',
    `r@rc-${uniquePrefix()}.example`,
  ]) {
    for (let i = 0; i < 5; i += 1) assert.equal((await ask(email)).status, 202);
    assert.equal(await codesFor(email), 5, email);
  }
});

test('a real address still gets at most 3 codes an hour', async () => {
  const email = `kemi.${uniquePrefix()}@gmail.com`;
  for (let i = 0; i < 5; i += 1) assert.equal((await ask(email)).status, 202);
  assert.equal(await codesFor(email), 3);
});
