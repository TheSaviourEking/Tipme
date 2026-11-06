import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { liveGate } from '../dist/live/live-gate.middleware.js';

function call(gate, { method = 'GET', path = '/v1/me/events' } = {}) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    locals: {},
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      this.emit('finish');
    },
  });
  let passed = false;
  gate({ method, path }, res, () => (passed = true));
  return { res, passed };
}

function metrics() {
  const counted = [];
  return { counted, connect: (outcome) => counted.push(outcome) };
}

test('with the flag off, both stream paths answer 204 before any guard or limit runs', () => {
  const m = metrics();
  const gate = liveGate({ enabled: false, metrics: m });
  for (const path of ['/v1/me/events', '/v1/ops/events']) {
    const { res, passed } = call(gate, { path });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
  }
  assert.deepEqual(m.counted, ['disabled', 'disabled']);
});

test('other paths and methods pass straight through, flag on or off', () => {
  for (const enabled of [true, false]) {
    const m = metrics();
    const gate = liveGate({ enabled, metrics: m });
    assert.equal(call(gate, { path: '/v1/me/profile' }).passed, true);
    assert.equal(call(gate, { method: 'POST' }).passed, true);
    assert.deepEqual(m.counted, []);
  }
});

test('with the flag on, a 401 counts as unauthenticated and the address limit’s 429 as rate_limited', () => {
  const m = metrics();
  const gate = liveGate({ enabled: true, metrics: m });
  const unauth = call(gate);
  assert.equal(unauth.passed, true);
  unauth.res.statusCode = 401;
  unauth.res.emit('finish');
  const limited = call(gate);
  limited.res.statusCode = 429;
  limited.res.emit('finish');
  // The route counted this one itself (LIVE_LIMIT): not again.
  const counted = call(gate);
  counted.res.locals.liveCounted = true;
  counted.res.statusCode = 429;
  counted.res.emit('finish');
  const opened = call(gate);
  opened.res.emit('finish');
  assert.deepEqual(m.counted, ['unauthenticated', 'rate_limited']);
});
