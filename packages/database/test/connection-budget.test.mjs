import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBudget } from '../dist/index.js';

const production = { apiProcesses: 6, workerProcesses: 2, margin: 7 };
const at = (maxConnections, reserved = 3, ownLimit = null) =>
  planBudget({ maxConnections, reserved, ownLimit }, production);

test('the numbers at each limit, with both colours running', () => {
  assert.deepEqual(at(15), {
    usable: 5,
    apiPool: 1,
    workerPool: 1,
    worstTotal: 8,
    overcommitted: true,
  });
  assert.deepEqual(at(20), {
    usable: 10,
    apiPool: 1,
    workerPool: 2,
    worstTotal: 10,
    overcommitted: false,
  });
  assert.deepEqual(at(50), {
    usable: 40,
    apiPool: 4,
    workerPool: 4,
    worstTotal: 32,
    overcommitted: false,
  });
  assert.deepEqual(at(100), {
    usable: 90,
    apiPool: 9,
    workerPool: 4,
    worstTotal: 62,
    overcommitted: false,
  });
});

test('never over budget unless the minimum itself is, which it says', () => {
  for (let limit = 1; limit <= 500; limit += 1) {
    const plan = at(limit);
    assert.ok(plan.apiPool >= 1 && plan.apiPool <= 10);
    assert.ok(plan.workerPool >= 1 && plan.workerPool <= 4);
    assert.equal(plan.overcommitted, plan.worstTotal > plan.usable);
    if (plan.worstTotal > plan.usable)
      assert.deepEqual([plan.apiPool, plan.workerPool], [1, 1], String(limit));
  }
});

test('a tiny limit clamps to the minimum and a role limit tightens the sum', () => {
  assert.equal(at(5).usable, 0);
  assert.deepEqual([at(5).apiPool, at(5).workerPool], [1, 1]);
  assert.equal(at(100, 3, 12).usable, 12);
  assert.deepEqual([at(100, 3, 12).apiPool, at(100, 3, 12).workerPool], [1, 2]);
});
