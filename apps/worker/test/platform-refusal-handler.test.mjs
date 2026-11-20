import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlePlatformRefusal } from '../dist/handlers/platform-refusal.js';

test("You collect's debt freeze is posted to the alert route in its own words", async () => {
  const posted = [];
  const outcome = await handlePlatformRefusal(
    { cause: 'collect_in_debt' },
    {
      url: 'https://hooks.example.test/route',
      fetchImpl: async (_url, init) => {
        posted.push(JSON.parse(init.body).text);
        return new Response('ok', { status: 200 });
      },
    },
  );
  assert.equal(outcome, 'sent');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /in debt/);
  assert.match(posted[0], /You collect transfer has stopped/);
  // Staff-facing: no partner name in the chat room either.
  assert.doesNotMatch(posted[0], /Bachs/);
});
