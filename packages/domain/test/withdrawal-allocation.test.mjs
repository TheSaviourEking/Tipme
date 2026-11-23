import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateWithdrawal,
  withdrawalMinimumMinor,
  withdrawalPartCount,
} from '../dist/index.js';

const M = withdrawalMinimumMinor();
// The fixtures use fractions of M (down to M/10); they are exact only when M divides evenly.
assert.equal(M % 20n, 0n, 'minimum must be divisible by 20 for exact fixtures');

// Deterministic LCG so failures are reproducible.
let seed = 7n;
const next = (max) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return (seed >> 16n) % max;
};

describe('allocateWithdrawal', () => {
  it('uses one provider that covers the amount alone, first in drain order', () => {
    assert.deepEqual(allocateWithdrawal(2n * M, [3n * M, 10n * M]), [
      2n * M,
      0n,
    ]);
    assert.deepEqual(allocateWithdrawal(5n * M, [3n * M, 10n * M]), [
      0n,
      5n * M,
    ]);
  });

  it('splits in drain order when none covers it', () => {
    assert.deepEqual(allocateWithdrawal(12n * M, [3n * M, 10n * M]), [
      3n * M,
      9n * M,
    ]);
  });

  it('allows a part that empties a provider to be below the minimum', () => {
    assert.deepEqual(allocateWithdrawal(10n * M + M / 4n, [M / 2n, 10n * M]), [
      M / 2n,
      10n * M - M / 4n,
    ]);
  });

  it('raises a small last part by taking less from the one before', () => {
    assert.deepEqual(allocateWithdrawal(5n * M + M / 2n, [5n * M, 5n * M]), [
      4n * M + M / 2n,
      M,
    ]);
    // Raised only to the last provider's cap.
    assert.deepEqual(
      allocateWithdrawal((8n * M) / 5n, [(6n * M) / 5n, M / 2n]),
      [(11n * M) / 10n, M / 2n],
    );
  });

  it('returns null when no fold keeps every part valid', () => {
    assert.equal(allocateWithdrawal((8n * M) / 5n, [M, (3n * M) / 2n]), null);
  });

  it('returns null above the total or at zero', () => {
    assert.equal(allocateWithdrawal(3n * M, [M, M]), null);
    assert.equal(allocateWithdrawal(0n, [M]), null);
  });

  it('returns null for an amount under the minimum that empties no provider', () => {
    assert.equal(allocateWithdrawal(M / 4n, [M, 10n * M]), null);
    assert.equal(allocateWithdrawal(M / 5n, [M / 10n, M / 2n]), null);
    // ...but the whole of a provider's balance may go, or everything at once.
    assert.deepEqual(allocateWithdrawal(M / 4n, [M, M / 4n]), [0n, M / 4n]);
    assert.deepEqual(allocateWithdrawal(M / 2n, [M / 4n, M / 4n]), [
      M / 4n,
      M / 4n,
    ]);
  });

  it('counts the non-zero parts', () => {
    assert.equal(withdrawalPartCount(12n * M, [3n * M, 10n * M]), 2);
    assert.equal(withdrawalPartCount(2n * M, [3n * M, 10n * M]), 1);
    assert.equal(withdrawalPartCount(3n * M, [M, M]), null);
  });

  it('keeps every rule over random inputs', () => {
    let nonNull = 0;
    for (let i = 0; i < 500; i++) {
      const n = 1 + Number(next(4n));
      const caps = Array.from({ length: n }, () => next(6n * M + 1n));
      const total = caps.reduce((a, b) => a + b, 0n);
      const amount = total === 0n ? 1n : 1n + next(total + M / 4n);
      const parts = allocateWithdrawal(amount, caps);
      if (parts === null) continue;
      nonNull++;
      assert.equal(parts.length, caps.length);
      assert.equal(
        parts.reduce((a, b) => a + b, 0n),
        amount,
      );
      parts.forEach((p, j) => {
        assert.ok(p >= 0n && p <= caps[j]);
        if (p > 0n) assert.ok(p >= M || p === caps[j]);
      });
    }
    assert.ok(nonNull > 100);
  });
});
