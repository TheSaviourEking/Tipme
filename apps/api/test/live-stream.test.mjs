import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openStream } from '../dist/live/live.controller.js';

const USER = '11111111-1111-4111-8111-111111111111';

function fakes({
  destroyed = false,
  ended = false,
  reqDestroyed = destroyed,
} = {}) {
  const socket = { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} };
  const req = Object.assign(new EventEmitter(), {
    socket,
    destroyed: reqDestroyed,
  });
  const writes = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed,
    writableEnded: ended,
    locals: {},
    headers: {},
    statusCode: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(frame) {
      writes.push(frame);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  const registered = [];
  const hub = {
    subscriberUp: true,
    register(sink) {
      registered.push(sink.id);
      return { ok: true };
    },
    unregister(id) {
      const i = registered.indexOf(id);
      if (i !== -1) registered.splice(i, 1);
    },
  };
  const counted = [];
  const metrics = {
    connect: (o) => counted.push(['connect', o]),
    close: (r) => counted.push(['close', r]),
  };
  const logger = { warn() {}, info() {} };
  const sink = {
    kind: 'me',
    userId: USER,
    profileId: null,
    permissions: null,
    recheck: async () => true,
  };
  const open = () =>
    openStream({
      req,
      res,
      hub,
      metrics,
      logger,
      sink,
      expiresAt: null,
      heartbeatMs: 60_000,
    });
  return { req, res, hub, registered, counted, writes, open };
}

test('a request already gone before the stream opens registers nothing', () => {
  for (const state of [{ destroyed: true }, { ended: true }]) {
    const f = fakes(state);
    f.open();
    assert.deepEqual(f.registered, [], JSON.stringify(state));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.counted, [['connect', 'client_gone']]);
  }
});

test('the response closing tears the stream down and frees its slot', () => {
  const f = fakes();
  f.open();
  assert.equal(f.registered.length, 1);
  // Node fires the response's close even when the request's close has already passed.
  f.res.emit('close');
  assert.deepEqual(f.registered, []);
  assert.deepEqual(f.counted.at(-1), ['close', 'client']);
});

test('a request whose body was read (req.destroyed) still opens: only the response says the client left', () => {
  // Node marks a request destroyed once anything drains it, while its response is still open.
  const f = fakes({ reqDestroyed: true });
  f.open();
  assert.equal(f.registered.length, 1);
  f.res.emit('close');
  assert.deepEqual(f.registered, []);
});
