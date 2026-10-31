import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISSUE_EVENT_NAMES } from '@tipme/database';
import { DOMAIN_EVENT_NAMES } from '../dist/handlers/domain-events.js';

test('fix: every event that opens an issue reaches the worker', () => {
  for (const name of ISSUE_EVENT_NAMES)
    assert.ok(DOMAIN_EVENT_NAMES.has(name), `${name} is routed`);
});
