import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneConfig } from '../tests/lane.mjs';

test('lane 0 and unset are the original single-run stack', () => {
  for (const value of [undefined, '', '0', 0]) {
    const lane = laneConfig(value);
    assert.equal(lane.webPort, 3100);
    assert.equal(lane.apiPort, 4100);
    assert.equal(lane.webOrigin, 'http://127.0.0.1:3100');
    assert.equal(lane.apiOrigin, 'http://127.0.0.1:4100');
    assert.equal(lane.databaseName, 'tipme_test');
    assert.equal(lane.redisDb, null);
    assert.equal(lane.queuePrefix, 'e2e');
  }
});

test('lanes never share a port, database, redis db or queue prefix', () => {
  const lanes = [0, 1, 2].map((n) => laneConfig(n));
  for (const key of [
    'webPort',
    'apiPort',
    'databaseName',
    'redisDb',
    'queuePrefix',
    'outputDir',
  ])
    assert.equal(new Set(lanes.map((l) => l[key])).size, 3, key);
  assert.deepEqual([lanes[1].webPort, lanes[1].apiPort], [3110, 4110]);
  assert.deepEqual([lanes[2].webPort, lanes[2].apiPort], [3120, 4120]);
  assert.match(lanes[1].queuePrefix, /^[a-z0-9-]{1,32}$/);
});

test('a bad lane is refused', () => {
  for (const bad of ['x', '-1', '1.5', '10']) {
    assert.throws(() => laneConfig(bad), /E2E_LANE/);
  }
});

test('the TypeScript and script helpers agree', async () => {
  const ts = await import('../tests/lane.ts').catch(() => null);
  if (!ts) return; // this Node cannot load .ts; the CI Node can
  for (const n of [0, 1, 2, 9])
    assert.deepEqual(ts.laneConfig(n), laneConfig(n));
  assert.equal(
    ts.withDatabaseName('postgres://u:p@h:5447/tipme_local?x=1', 'a_b'),
    'postgres://u:p@h:5447/a_b?x=1',
  );
  assert.equal(ts.withRedisDb('redis://h:6393', 3), 'redis://h:6393/3');
  assert.equal(ts.withRedisDb('redis://h:6393', null), 'redis://h:6393');
});
