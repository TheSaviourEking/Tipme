import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { setWithdrawalsPaused } from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { startStack } from './helpers.mjs';

// The whole way: the change's outbox row, the relay, the worker's job dispatch, the alert route.
const STAFF = '00000000-0000-7000-8000-00000000f00d';
const REASON = 'A private written reason, for the audit log only.';

let database;
let stack;
let route;
const posted = [];

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  route = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      posted.push(JSON.parse(body).text);
      response.end('ok');
    });
  });
  route.listen(0, '127.0.0.1');
  await once(route, 'listening');
  stack = await startStack({
    databaseUrl: database.url,
    workerEnv: {
      ALERT_WEBHOOK_URL: `http://127.0.0.1:${route.address().port}/alerts`,
    },
  });
});
after(async () => {
  await stack.stop();
  route.closeAllConnections();
  await new Promise((resolve) => route.close(resolve));
  await database.close();
});

const waitForPosts = async (count) => {
  const deadline = Date.now() + 15_000;
  while (posted.length < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(posted.length, count, 'alerts posted');
};

test('a switch change reaches the alert route through the job queue, without its reason', async () => {
  const change = (paused) =>
    setWithdrawalsPaused(database.db, {
      paused,
      staffUserId: STAFF,
      reason: REASON,
    });
  await change(true);
  await waitForPosts(1);
  assert.match(posted[0], /switched OFF/);
  await change(false);
  await waitForPosts(2);
  assert.match(posted[1], /switched back ON/);
  assert.equal(posted.join(' ').includes('private written reason'), false);
  const outcome = (name) =>
    stack.logs.filter((line) => line.event === name).length;
  assert.equal(outcome('withdrawals.switch_alert_unrouted'), 0);
});
