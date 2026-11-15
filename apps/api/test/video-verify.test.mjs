import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  OEMBED_ENDPOINTS,
  pretendVerifyVideo,
  verifyVideo,
} from '../dist/studio/video-verify.js';

// Page Studio's broken-video check (owner ruling 5): the server asks the site's public oEmbed
// endpoint whether a video exists. Here the "site" is a local server: never the real ones.

let server;
let origin;
const seen = [];
let answer = () => ({ status: 200, body: '{"title":"x"}' });
before(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    const { status, body, delay } = answer(request);
    setTimeout(
      () =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(body),
      delay ?? 0,
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** fetch, sent to the local server instead of the site, keeping the path and query. */
const local = (url, init) => {
  const u = new URL(url);
  return fetch(`${origin}${u.pathname}${u.search}`, init);
};
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('each site is asked at its own oEmbed endpoint, with the video link', async () => {
  seen.length = 0;
  answer = () => ({ status: 200, body: '{}' });
  for (const url of [
    YT,
    'https://www.tiktok.com/@ifyplays/video/7301234567890123456',
    'https://audiomack.com/kemisings/song/lagos-rain',
  ])
    assert.equal(await verifyVideo(url, { fetch: local }), 'ok', url);
  assert.deepEqual(
    seen.map((r) => new URL(r.url, origin).pathname),
    [
      new URL(OEMBED_ENDPOINTS.youtube).pathname,
      new URL(OEMBED_ENDPOINTS.tiktok).pathname,
      new URL(OEMBED_ENDPOINTS.audiomack).pathname,
    ],
  );
  assert.equal(new URL(seen[0].url, origin).searchParams.get('url'), YT);
  assert.ok(OEMBED_ENDPOINTS.youtube.startsWith('https://www.youtube.com/'));
});

test('404, 401, 403 and 410 mean the video is gone; 5xx and timeouts are unknown, never gone', async () => {
  for (const [status, expected] of [
    [404, 'gone'],
    [401, 'gone'],
    [403, 'gone'],
    [410, 'gone'],
    [500, 'unknown'],
    [503, 'unknown'],
    [429, 'unknown'],
  ]) {
    answer = () => ({ status, body: '' });
    assert.equal(
      await verifyVideo(YT, { fetch: local }),
      expected,
      String(status),
    );
  }
  answer = () => ({ status: 200, body: '{}', delay: 500 });
  const started = Date.now();
  assert.equal(
    await verifyVideo(YT, { fetch: local, timeoutMs: 100 }),
    'unknown',
  );
  assert.ok(Date.now() - started < 450, 'the timeout is kept');
  assert.equal(
    await verifyVideo(YT, {
      fetch: () => Promise.reject(new Error('offline')),
    }),
    'unknown',
  );
});

test('no cookie or credential is sent, and a link from another site is never fetched', async () => {
  seen.length = 0;
  answer = () => ({ status: 200, body: '{}' });
  await verifyVideo(YT, { fetch: local });
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  let called = false;
  assert.equal(
    await verifyVideo('https://www.instagram.com/reel/abc/', {
      fetch: () => ((called = true), Promise.resolve(new Response('{}'))),
    }),
    'unknown',
  );
  assert.equal(called, false);
});

test('outside production a pretend check answers, so tests never call the real sites', async () => {
  assert.equal(
    await pretendVerifyVideo('https://youtu.be/goneGONE123'),
    'gone',
  );
  assert.equal(
    await pretendVerifyVideo('https://youtu.be/slowSLOW123'),
    'unknown',
  );
  assert.equal(await pretendVerifyVideo(YT), 'ok');
});
