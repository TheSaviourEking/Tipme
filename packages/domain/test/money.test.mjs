import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CurrencyMismatchError,
  addMoney,
  formatMinor,
  money,
  subtractMoney,
} from '../dist/index.js';

test('currencies must be ISO 4217 style and amounts non-negative bigints', () => {
  assert.throws(() => money(1n, 'ngn'), RangeError);
  assert.throws(() => money(-1n, 'NGN'), RangeError);
  assert.throws(() => money(9_007_199_254_740_991_001n, 'NGN'), RangeError);
  assert.deepEqual(money(5n, 'NGN'), { minor: 5n, currency: 'NGN' });
});

test('arithmetic refuses mixed currencies and negative results', () => {
  assert.throws(
    () => addMoney(money(1n, 'NGN'), money(1n, 'USD')),
    CurrencyMismatchError,
  );
  assert.throws(
    () => subtractMoney(money(1n, 'NGN'), money(2n, 'NGN')),
    RangeError,
  );
  assert.deepEqual(
    addMoney(money(2n, 'NGN'), money(3n, 'NGN')),
    money(5n, 'NGN'),
  );
  assert.equal(formatMinor(123450n), '123450');
});
