import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareTransferKinds } from '../dist/share-transfer-kinds.js';

// Owner, 14 Nov 2026: on a chargeback TipMe always sends its fee back, so the worker moves fee
// returns whatever the switches. A business's own option B shares move only while the shares
// switches are on.
test('fee returns always move; the rest only while business shares are on', () => {
  assert.equal(shareTransferKinds({ sharesOn: true }), undefined);
  const off = shareTransferKinds({ sharesOn: false });
  assert.ok(off.includes('fee_return'));
  for (const kind of ['sweep', 'recover', 'holdback_repay'])
    assert.equal(off.includes(kind), false, kind);
});

// You collect (final review I2): a collect tip's business money is held on TipMe's own account, or
// owed back to it. Turning `business` or `business_shares` off stops new shares at the quote, never
// this money: its sweep, a lost dispute's or refund's pull-back, and a return always move.
test('You collect business money moves whatever the business switches', () => {
  const off = shareTransferKinds({ sharesOn: false });
  for (const kind of ['collect_sweep', 'collect_recover', 'collect_return'])
    assert.ok(off.includes(kind), kind);
});
