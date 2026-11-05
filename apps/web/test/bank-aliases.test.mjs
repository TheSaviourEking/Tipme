import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BANK_ALIASES,
  aliasMatches,
  normalizeBankText,
} from '../src/lib/bank-aliases.ts';

test('bank text is compared without case, accents or punctuation', () => {
  assert.equal(normalizeBankText('  Paycom (OPay) Ltd. '), 'paycom opay ltd');
  assert.equal(normalizeBankText('A&B  Bank'), 'a and b bank');
  assert.equal(normalizeBankText('Société Générale'), 'societe generale');
});

test('gtb, gtco and guaranty all find Guaranty Trust Bank', () => {
  for (const q of ['gtb', 'gtco', 'guaranty', 'GTB', 'gt'])
    assert.ok(aliasMatches(normalizeBankText(q), 'Guaranty Trust Bank'), q);
  assert.equal(aliasMatches('gtb', 'Guaranty Trust Bank'), 'exact');
  assert.equal(aliasMatches('gtc', 'Guaranty Trust Bank'), 'prefix');
});

test('fbn finds First Bank and never First City Monument Bank', () => {
  assert.equal(aliasMatches('fbn', 'First Bank of Nigeria'), 'exact');
  assert.equal(aliasMatches('fbn', 'First City Monument Bank'), null);
  assert.equal(aliasMatches('fcmb', 'First City Monument Bank'), 'exact');
});

test('opay finds the bank whatever name the partner gives it', () => {
  assert.equal(aliasMatches('opay', 'Paycom (OPay)'), 'exact');
  assert.equal(aliasMatches('opay', 'OPay Digital Services Limited'), 'exact');
  assert.equal(aliasMatches('palmpay', 'Palm Pay'), 'exact');
  assert.equal(aliasMatches('alat', 'Wema Bank'), 'exact');
});

test('one letter is never an alias match, and unknown words never match', () => {
  assert.equal(aliasMatches('g', 'Guaranty Trust Bank'), null);
  assert.equal(aliasMatches('zz', 'Guaranty Trust Bank'), null);
});

test('the alias list is well formed: lowercase, normalized, no alias used twice', () => {
  const seen = new Set();
  for (const { aliases, names } of BANK_ALIASES) {
    assert.ok(aliases.length > 0 && names.length > 0);
    for (const word of [...aliases, ...names])
      assert.equal(normalizeBankText(word), word, word);
    for (const alias of aliases) {
      assert.ok(!seen.has(alias), `${alias} is listed twice`);
      seen.add(alias);
    }
  }
});
