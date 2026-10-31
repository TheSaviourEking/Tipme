import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codesPerHourFor } from '../dist/auth/code-limit.js';

// Sign-in codes per address per hour. The release check signs the same staff address in on every
// deploy; on a test copy its codes only reach the pretend inbox, so the limit is lifted for
// addresses that can never receive mail. Everything else keeps the normal limit.

const staging = {
  releaseKind: 'test',
  pretendDomains: ['release-check.usetipme.xyz'],
  normal: 3,
};

test('on a test copy, the release staff and reserved test addresses get the lifted limit', () => {
  assert.equal(
    codesPerHourFor('release@release-check.usetipme.xyz', staging),
    100,
  );
  assert.equal(codesPerHourFor('r@rc-1a2b.example', staging), 100);
});

test('real addresses keep the normal limit, on any copy', () => {
  assert.equal(codesPerHourFor('ada@gmail.com', staging), 3);
  assert.equal(codesPerHourFor('someone@example.com', staging), 3);
});

test('on a live copy, nobody gets the lifted limit', () => {
  assert.equal(
    codesPerHourFor('release@release-check.usetipme.xyz', {
      ...staging,
      releaseKind: 'live',
    }),
    3,
  );
});
