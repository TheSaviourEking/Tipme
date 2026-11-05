import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabaseName } from '../dist/test-support.js';

test('TIPME_TEST_DATABASE accepts only the test database and its lanes', () => {
  assert.equal(testDatabaseName(undefined), 'tipme_test');
  assert.equal(testDatabaseName(''), 'tipme_test');
  assert.equal(testDatabaseName('tipme_test'), 'tipme_test');
  assert.equal(testDatabaseName('tipme_test_lane2'), 'tipme_test_lane2');
  for (const bad of [
    'tipme_local',
    'tipme_test_lane',
    'tipme_test_lane10',
    'tipme_test2',
  ])
    assert.throws(
      () => testDatabaseName(bad),
      /must be tipme_test or tipme_test_laneN/,
    );
});
