import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WHO } from '../src/lib/who-choices.ts';

// The header's "Who it's for" menu: owner's reference, plus the Infrastructure row he kept.

test('the menu is Individual, Business, Giving and Infrastructure, in that order', () => {
  assert.deepEqual(
    WHO.map((choice) => choice.title),
    ['Individual', 'Business', 'Giving', 'Infrastructure'],
  );
});

test('each row has the owner’s description and an icon', () => {
  assert.deepEqual(
    WHO.map((choice) => choice.text),
    [
      'Receive tips as an individual.',
      'Receive and manage tips for businesses and their employees.',
      'Receive and manage contributions for churches, organisations and causes.',
      'Consume the Tipme APIs.',
    ],
  );
  for (const choice of WHO) assert.ok(choice.icon.length > 0, choice.title);
});

test('Individual and Business link; Giving is words only and says coming soon', () => {
  const [individual, business, giving, infrastructure] = WHO;
  assert.equal(individual.href, '/for-creators');
  assert.equal(business.href, '/for-businesses');
  assert.equal(giving.href, undefined);
  assert.equal(giving.comingSoon, true);
  assert.equal(infrastructure.href, undefined);
  assert.equal(infrastructure.comingSoon, true);
  assert.equal(individual.comingSoon, undefined);
  assert.equal(business.comingSoon, undefined);
});

test('no "TipMe" prefix on the titles', () => {
  assert.doesNotMatch(JSON.stringify(WHO.map((c) => c.title)), /TipMe/);
});
