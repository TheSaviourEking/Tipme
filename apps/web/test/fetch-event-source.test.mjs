import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchEventSource } from '../src/lib/fetch-event-source.ts';

const flush = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A fake fetch: each call answers with the next status; a 200 streams the chunks the test pushes.
 * It records every request's init.
 */
function fakeFetch(statuses = [200]) {
  const calls = [];
  const streams = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response(null, { status });
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    const stream = {
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
    streams.push(stream);
    init?.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // Already closed.
      }
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
  return { fetch, calls, streams };
}

function open(fake, headers = { authorization: 'Bearer tok' }) {
  const reader = createFetchEventSource({ headers, fetch: fake.fetch });
  const source = new reader.EventSource('https://api.test/v1/tips/t/events', {
    withCredentials: true,
  });
  const seen = { opened: 0, messages: [], errors: 0, hb: 0 };
  source.onopen = () => (seen.opened += 1);
  source.onmessage = (event) => seen.messages.push(event.data);
  source.onerror = () => (seen.errors += 1);
  source.addEventListener('hb', () => (seen.hb += 1));
  return { reader, source, seen };
}

test('sends the bearer header and no credentials', async () => {
  const fake = fakeFetch([200]);
  const { source } = open(fake);
  await flush();
  assert.equal(fake.calls.length, 1);
  const { url, init } = fake.calls[0];
  assert.equal(url, 'https://api.test/v1/tips/t/events');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.authorization, 'Bearer tok');
  assert.equal(init.headers.accept, 'text/event-stream');
  // The token travels in the header only, never in the address.
  assert.equal(url.includes('tok'), false);
  source.close();
});

test('splits frames across chunks', async () => {
  const fake = fakeFetch([200]);
  const { source, seen } = open(fake);
  await flush();
  assert.equal(source.readyState, 1);
  assert.equal(seen.opened, 1);
  const stream = fake.streams[0];
  stream.push('retry: 5000\n\ndata: {"type":"re');
  await flush();
  assert.deepEqual(seen.messages, []);
  stream.push('ady"}\n');
  await flush();
  assert.deepEqual(seen.messages, []);
  stream.push('\ndata: {"type":"tip.changed"}\r\n\r\n: just a comment\n\n');
  await flush();
  assert.deepEqual(seen.messages, [
    '{"type":"ready"}',
    '{"type":"tip.changed"}',
  ]);
  assert.equal(seen.errors, 0);
  source.close();
  assert.equal(source.readyState, 2);
});

test('a 404 closes with readyState 2 and probe says disabled', async () => {
  const fake = fakeFetch([404]);
  const { reader, source, seen } = open(fake);
  await flush();
  assert.equal(seen.opened, 0);
  assert.equal(seen.errors, 1);
  assert.equal(source.readyState, 2);
  assert.equal(await reader.probe(), 'disabled');
  // The probe answers from what it saw: no second request.
  assert.equal(fake.calls.length, 1);
});

test('a 204 probe says disabled', async () => {
  const fake = fakeFetch([204]);
  const { reader, source } = open(fake);
  await flush();
  assert.equal(source.readyState, 2);
  assert.equal(await reader.probe(), 'disabled');
});

test('a 429 probe says refused', async () => {
  const fake = fakeFetch([429]);
  const { reader, seen } = open(fake);
  await flush();
  assert.equal(seen.errors, 1);
  assert.equal(await reader.probe(), 'refused');
  assert.equal(fake.calls.length, 1);
});

test('a 503 probe says refused, a 500 error, and a network failure error', async () => {
  for (const [status, answer] of [
    [503, 'refused'],
    [500, 'error'],
  ]) {
    const fake = fakeFetch([status]);
    const { reader } = open(fake);
    await flush();
    assert.equal(await reader.probe(), answer, String(status));
  }
  const reader = createFetchEventSource({
    headers: {},
    fetch: async () => {
      throw new TypeError('network');
    },
  });
  const source = new reader.EventSource('https://api.test/x', {
    withCredentials: false,
  });
  let errors = 0;
  source.onerror = () => (errors += 1);
  await flush();
  assert.equal(errors, 1);
  assert.equal(source.readyState, 2);
  assert.equal(await reader.probe(), 'error');
});

test("hb events reach addEventListener('hb')", async () => {
  const fake = fakeFetch([200]);
  const { source, seen } = open(fake);
  await flush();
  fake.streams[0].push(': hb\nevent: hb\ndata: {}\n\n');
  await flush();
  assert.equal(seen.hb, 1);
  // A named event never reaches onmessage.
  assert.deepEqual(seen.messages, []);
  source.close();
});

test('the server ending the stream is an error with readyState 2; closing it is not', async () => {
  const fake = fakeFetch([200, 200]);
  const first = open(fake);
  await flush();
  fake.streams[0].end();
  await flush();
  assert.equal(first.seen.errors, 1);
  assert.equal(first.source.readyState, 2);
  const second = open(fake);
  await flush();
  second.source.close();
  await flush();
  assert.equal(second.seen.errors, 0);
  // After a close nothing more reaches the page.
  assert.equal(second.seen.messages.length, 0);
});

test('a 200 that is not an event stream is an error', async () => {
  const reader = createFetchEventSource({
    headers: {},
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const source = new reader.EventSource('https://api.test/x', {
    withCredentials: false,
  });
  let errors = 0;
  let opened = 0;
  source.onerror = () => (errors += 1);
  source.onopen = () => (opened += 1);
  await flush();
  assert.equal(opened, 0);
  assert.equal(errors, 1);
  assert.equal(source.readyState, 2);
  assert.equal(await reader.probe(), 'error');
});
