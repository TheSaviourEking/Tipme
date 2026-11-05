import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  POPULAR_BANKS,
  arrangeBanks,
  bankKind,
  contrastRatio,
  initialsFor,
} from '../src/lib/bank-directory.ts';

const LIST = [
  { code: '057', name: 'Zenith Bank' },
  { code: '090001', name: 'LAPO Microfinance Bank' },
  { code: '044', name: 'Access Bank' },
  { code: '070001', name: 'Abbey Mortgage Bank' },
  { code: '50515', name: 'Moniepoint MFB' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '100002', name: 'Paga' },
];

test('microfinance and mortgage banks are told apart by their names', () => {
  assert.equal(bankKind('LAPO Microfinance Bank'), 'microfinance');
  assert.equal(bankKind('Fina Trust Micro Finance Bank'), 'microfinance');
  assert.equal(bankKind('Moniepoint MFB'), 'microfinance');
  assert.equal(bankKind('Abbey Mortgage Bank'), 'mortgage');
  assert.equal(bankKind('FSDH Merchant Bank'), 'bank');
  assert.equal(bankKind('Paga'), 'bank');
  assert.equal(bankKind('Finance House'), 'bank');
});

test('a popular key shows only when its code is in the partner list', () => {
  const { popular } = arrangeBanks(LIST);
  assert.deepEqual(
    popular.map((bank) => bank.popularLabel),
    ['Access', 'Zenith', 'Moniepoint'],
  );
  // A bank named like GTBank but under another code is not GTBank's key.
  const lookalike = arrangeBanks([
    { code: '999', name: 'Guaranty Trust Bank' },
  ]);
  assert.deepEqual(lookalike.popular, []);
});

// Owner ruling (5 Nov 2026): the fintech codes could not be checked against the partner's live
// list, so a fintech the partner lists under a code we don't know shows no key. It stays in
// A to Z (or More banks) and is still found by search.
test('a fintech under a code we do not know shows no key, and is still listed', () => {
  const { popular, all, more } = arrangeBanks([
    { code: '305', name: 'Paycom (OPay)' },
    { code: '090999', name: 'Kuda Microfinance Bank' },
    { code: '044', name: 'Access Bank' },
  ]);
  assert.deepEqual(
    popular.map((bank) => bank.popularLabel),
    ['Access'],
  );
  assert.ok(all.some((bank) => bank.name === 'Paycom (OPay)'));
  assert.ok(more.some((bank) => bank.name === 'Kuda Microfinance Bank'));
  for (const bank of [...all, ...more])
    if (bank.code !== '044') {
      assert.equal(bank.popularLabel, null);
      assert.equal(bank.badge.tone, null);
    }
});

test('A to Z after the popular keys, with microfinance and mortgage under More banks', () => {
  const { all, more } = arrangeBanks(LIST);
  assert.deepEqual(
    all.map((bank) => bank.name),
    [
      'Access Bank',
      'Citibank Nigeria',
      'First City Monument Bank',
      'Moniepoint MFB',
      'Paga',
      'Zenith Bank',
    ],
  );
  assert.deepEqual(
    more.map((bank) => bank.name),
    ['Abbey Mortgage Bank', 'LAPO Microfinance Bank'],
  );
});

test('a popular microfinance bank stays in A to Z, never under More banks', () => {
  const { all, more } = arrangeBanks(LIST);
  assert.ok(all.some((bank) => bank.code === '50515'));
  assert.ok(!more.some((bank) => bank.code === '50515'));
});

test('a code listed twice keeps its first name', () => {
  const { all } = arrangeBanks([
    { code: '044', name: 'Access Bank' },
    { code: '044', name: 'Access Bank (Diamond)' },
  ]);
  assert.deepEqual(
    all.map((bank) => bank.name),
    ['Access Bank'],
  );
});

test('badge initials follow the board', () => {
  assert.equal(initialsFor('Citibank Nigeria'), 'CI');
  assert.equal(initialsFor('Ecobank Nigeria'), 'EC');
  assert.equal(initialsFor('Fidelity Bank'), 'FI');
  assert.equal(initialsFor('First City Monument Bank'), 'FC');
  assert.equal(initialsFor('LAPO Microfinance Bank'), 'LA');
  assert.equal(initialsFor('Bank'), 'BA');
});

test('every popular badge reads at 4.5:1 or better', () => {
  const { popular } = arrangeBanks(
    POPULAR_BANKS.map(({ label, codes }) => ({ code: codes[0], name: label })),
  );
  assert.equal(popular.length, POPULAR_BANKS.length);
  for (const { badge, popularLabel } of popular)
    assert.ok(
      contrastRatio(badge.tone, badge.ink) >= 4.5,
      `${popularLabel}: ${badge.ink} on ${badge.tone}`,
    );
});

test('no code belongs to two popular banks', () => {
  const codes = POPULAR_BANKS.flatMap((bank) => bank.codes);
  assert.equal(new Set(codes).size, codes.length);
});
