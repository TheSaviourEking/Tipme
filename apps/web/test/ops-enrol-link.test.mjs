import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTemporaryFailure,
  keepsEnrolLink,
} from '../src/lib/ops-enrol-link.ts';

test('a passing failure is temporary; an answer is not', () => {
  for (const status of [0, 429, 500, 502, 503])
    assert.ok(isTemporaryFailure(status), String(status));
  for (const status of [200, 400, 401, 403, 404])
    assert.ok(!isTemporaryFailure(status), String(status));
});

test('the link survives only for the enrolment step and a retry', () => {
  for (const step of ['needs_enrolment', 'retry'])
    assert.ok(keepsEnrolLink(step), step);
  for (const step of ['unavailable', 'needs_code', 'granted'])
    assert.ok(!keepsEnrolLink(step), step);
});
