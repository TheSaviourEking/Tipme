import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createLiveHub } from '../dist/live/live-hub.service.js';
import { createLivePublisher } from '../dist/live/live-publisher.js';
import { startLiveSubscriber } from '../dist/live/live-subscriber.js';

const PROFILE = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

function fakeLogger() {
  const lines = [];
  const at = (level) => (entry) => lines.push({ level, ...entry });
  return {
    lines,
    logger: {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
    },
  };
}

class FakeRedis extends EventEmitter {
  subscribed = [];
  connects = 0;
  disconnected = false;
  connect() {
    this.connects += 1;
    return Promise.resolve();
  }
  subscribe(channel) {
    this.subscribed.push(channel);
    return Promise.resolve(1);
  }
  disconnect() {
    this.disconnected = true;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a publish sends {to,type} JSON on the channel', async () => {
  const calls = [];
  const counted = [];
  const { logger } = fakeLogger();
  const publish = createLivePublisher({
    redis: {
      publish: async (channel, message) => {
        calls.push([channel, message]);
        return 1;
      },
    },
    channel: 'p:live:v1',
    logger,
    counter: (type, outcome) => counted.push([type, outcome]),
  });
  await publish({ to: { profile: PROFILE }, type: 'tips.changed' });
  assert.deepEqual(calls, [
    ['p:live:v1', `{"to":{"profile":"${PROFILE}"},"type":"tips.changed"}`],
  ]);
  assert.deepEqual(counted, [['tips.changed', 'ok']]);
});

test('a publish while Redis is down resolves, logs live.publish_failed and counts outcome=failed', async () => {
  const counted = [];
  const { logger, lines } = fakeLogger();
  const publish = createLivePublisher({
    redis: {
      publish: async () => {
        throw new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        );
      },
    },
    channel: 'p:live:v1',
    logger,
    counter: (type, outcome) => counted.push([type, outcome]),
  });
  await publish({ to: { profile: PROFILE }, type: 'tips.changed' });
  assert.deepEqual(counted, [['tips.changed', 'failed']]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'live.publish_failed');
  assert.equal(lines[0].error, 'Error');
  assert.ok(
    !JSON.stringify(lines[0]).includes(PROFILE),
    'no ids in the log line',
  );
});

test('a publish whose call throws synchronously still resolves', async () => {
  const counted = [];
  const { logger } = fakeLogger();
  const publish = createLivePublisher({
    redis: {
      publish: () => {
        throw new TypeError('boom');
      },
    },
    channel: 'p:live:v1',
    logger,
    counter: (type, outcome) => counted.push([type, outcome]),
  });
  await publish({ to: { user: USER }, type: 'sessions.changed' });
  assert.deepEqual(counted, [['sessions.changed', 'failed']]);
});

function hubWithFake() {
  const fake = new FakeRedis();
  const { logger, lines } = fakeLogger();
  const hub = createLiveHub({
    url: 'redis://127.0.0.1:1',
    channel: 'p:live:v1',
    logger,
    maxStreams: 2000,
    createClient: () => fake,
  });
  return { fake, hub, lines };
}

function sink() {
  const s = {
    id: 'sink-1',
    kind: 'me',
    userId: USER,
    profileId: PROFILE,
    permissions: null,
    writes: [],
    write: (frame) => s.writes.push(frame),
    close: () => undefined,
    recheck: async () => true,
  };
  return s;
}

test('subscriber down sends poll to every stream; restored sends resync', async (t) => {
  const { fake, hub, lines } = hubWithFake();
  hub.start();
  t.after(() => hub.stop());
  fake.emit('ready');
  await tick();
  assert.equal(hub.subscriberUp, true);
  const s = sink();
  assert.deepEqual(hub.register(s), { ok: true });
  fake.emit('end');
  fake.emit('close');
  assert.equal(hub.subscriberUp, false);
  fake.emit('ready');
  await tick();
  assert.equal(hub.subscriberUp, true);
  assert.deepEqual(s.writes, [
    'data: {"type":"poll"}\n\n',
    'data: {"type":"resync"}\n\n',
  ]);
  assert.equal(
    lines.filter((l) => l.event === 'live.subscriber_down').length,
    1,
  );
  assert.equal(
    lines.filter((l) => l.event === 'live.subscriber_restored').length,
    1,
  );
});

test('an invalid channel message is dropped, logged live.message_invalid and counted', async (t) => {
  const { fake, hub, lines } = hubWithFake();
  hub.start();
  t.after(() => hub.stop());
  fake.emit('ready');
  await tick();
  const s = sink();
  hub.register(s);
  fake.emit(
    'message',
    'p:live:v1',
    '{"to":{"profile":"x"},"type":"tips.changed"}',
  );
  assert.deepEqual(s.writes, []);
  assert.equal(
    lines.filter((l) => l.event === 'live.message_invalid').length,
    1,
  );
  assert.equal(hub.invalidCount, 1);
  fake.emit(
    'message',
    'p:live:v1',
    JSON.stringify({ to: { profile: PROFILE }, type: 'tips.changed' }),
  );
  assert.deepEqual(s.writes, ['data: {"type":"tips.changed"}\n\n']);
});

test('the subscriber subscribes on every ready, not before', async () => {
  const fake = new FakeRedis();
  const { logger } = fakeLogger();
  const sub = startLiveSubscriber({
    url: 'redis://127.0.0.1:1',
    channel: 'p:live:v1',
    logger,
    onMessage: () => undefined,
    onDown: () => undefined,
    onUp: () => undefined,
    onInvalid: () => undefined,
    createClient: () => fake,
  });
  assert.equal(fake.connects, 1);
  assert.deepEqual(fake.subscribed, []);
  assert.equal(sub.up, false);
  fake.emit('ready');
  await tick();
  assert.deepEqual(fake.subscribed, ['p:live:v1']);
  assert.equal(sub.up, true);
  fake.emit('close');
  fake.emit('ready');
  await tick();
  assert.deepEqual(fake.subscribed, ['p:live:v1', 'p:live:v1']);
  await sub.stop();
  assert.equal(fake.disconnected, true);
});
