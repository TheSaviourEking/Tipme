import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WHO } from '../src/lib/who-choices.ts';

// The header's "Who it's for" menu: three rows, owner's reference.

test('the menu is Individual, Business and Giving, in that order', () => {
  assert.deepEqual(
    WHO.map((choice) => choice.title),
    ['Individual', 'Business', 'Giving'],
  );
});

test('each row has the owner’s description and an icon', () => {
  assert.deepEqual(
    WHO.map((choice) => choice.text),
    [
      'Receive tips as an individual.',
      'Receive and manage tips for businesses and their employees.',
      'Receive and manage contributions for churches, organisations and causes.',
    ],
  );
  for (const choice of WHO) assert.ok(choice.icon.length > 0, choice.title);
});

test('Individual and Business link; Giving is words only and says coming soon', () => {
  const [individual, business, giving] = WHO;
  assert.equal(individual.href, '/for-creators');
  assert.equal(business.href, '/for-businesses');
  assert.equal(giving.href, undefined);
  assert.equal(giving.comingSoon, true);
  assert.equal(individual.comingSoon, undefined);
  assert.equal(business.comingSoon, undefined);
});

test('Infrastructure and the TipMe prefix are gone', () => {
  const words = JSON.stringify(WHO);
  assert.doesNotMatch(words, /Infrastructure|APIs|TipMe Individual/);
});
