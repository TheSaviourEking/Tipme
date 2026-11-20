import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareTransferKinds } from '../dist/share-transfer-kinds.js';

// Owner, 14 Nov 2026: on a chargeback TipMe always sends its fee back, so the worker moves fee
// returns whatever the switches. A business's shares move only while the shares switches are on.
test('fee returns always move; the rest only while business shares are on', () => {
  assert.deepEqual(shareTransferKinds({ sharesOn: false }), ['fee_return']);
  assert.equal(shareTransferKinds({ sharesOn: true }), undefined);
});

// You collect (R3): a collect tip's business share is a business share like any other.
test("a collect tip's business share moves only while business shares are on", () => {
  assert.equal(
    shareTransferKinds({ sharesOn: false }).includes('collect_sweep'),
    false,
  );
});
