import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Discarding a Studio draft (styles plan Task 15, PR 5b; spec §12.3) counts against the same
// allowance as saving and publishing it (`studio_drafts`, 60 a minute): each discard locks the page
// and may remove photos, so a script can't hammer it. Its own stack (its own rate-limit prefix), so
// using up the allowance can't touch another file's saves.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  await setSwitch(database.pool, 'page_studio', true);
});
after(async () => {
  await stack.stop();
  await database.close();
});

test('discarding the draft shares the Studio save allowance', async () => {
  const { cookie } = await signIn(stack.api, '+2348031280090');
  await fetch(`${stack.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ handle: 'discard_limit' }),
  });
  const discard = () =>
    fetch(`${stack.api}/v1/me/studio/draft`, {
      method: 'DELETE',
      headers: browserHeaders(cookie),
    });
  // A minute's window can turn over mid-test: start near the beginning of one.
  const into = Date.now() % 60_000;
  if (into > 40_000)
    await new Promise((resolve) => setTimeout(resolve, 60_500 - into));
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await discard()).status);
  assert.deepEqual(statuses.slice(0, 60), Array(60).fill(200));
  assert.equal(statuses[60], 429);
  // Saving is the same allowance: it is used up too.
  const save = await fetch(`${stack.api}/v1/me/studio/draft`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({
      rev: 0,
      draft: {
        v: 2,
        style: 'clear',
        accent: null,
        mode: 'light',
        cover: 'yours',
        blocks: [],
      },
    }),
  });
  assert.equal(save.status, 429);
});
