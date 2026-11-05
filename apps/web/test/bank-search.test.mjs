import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeBanks } from '../src/lib/bank-directory.ts';
import { matchCountText, searchBanks } from '../src/lib/bank-search.ts';

const dir = arrangeBanks([
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '999992', name: 'Paycom (OPay)' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '090001', name: 'LAPO Microfinance Bank' },
  { code: '070001', name: 'Abbey Mortgage Bank' },
]);

test('an empty or blank query shows the grouped view, not a search', () => {
  assert.equal(searchBanks(dir, ''), null);
  assert.equal(searchBanks(dir, '   '), null);
});

test('typing gtb finds Guaranty Trust Bank and underlines G, T and B', () => {
  const [first, ...rest] = searchBanks(dir, 'gtb');
  assert.equal(first.bank.name, 'Guaranty Trust Bank');
  assert.deepEqual(first.marks, [
    [0, 1],
    [9, 10],
    [15, 16],
  ]);
  assert.equal(rest.length, 0);
});

test('fir finds both First banks, with the typed letters underlined, and not Fidelity', () => {
  const names = searchBanks(dir, 'fir').map((m) => m.bank.name);
  assert.deepEqual(names, [
    'First Bank of Nigeria',
    'First City Monument Bank',
  ]);
  assert.deepEqual(searchBanks(dir, 'fir')[0].marks, [[0, 3]]);
});

test('fbn puts First Bank first; first city finds FCMB by its words', () => {
  assert.equal(searchBanks(dir, 'fbn')[0].bank.name, 'First Bank of Nigeria');
  assert.equal(
    searchBanks(dir, 'first city')[0].bank.name,
    'First City Monument Bank',
  );
});

test('search reaches the banks under More banks', () => {
  assert.equal(searchBanks(dir, 'lapo')[0].bank.name, 'LAPO Microfinance Bank');
  assert.equal(
    searchBanks(dir, 'mortgage')[0].bank.name,
    'Abbey Mortgage Bank',
  );
});

test('opay finds Paycom (OPay) through its alias', () => {
  assert.equal(searchBanks(dir, 'opay')[0].bank.name, 'Paycom (OPay)');
});

test('case, accents and punctuation do not matter', () => {
  assert.equal(searchBanks(dir, 'STANBIC')[0].bank.name, 'Stanbic IBTC Bank');
  assert.equal(
    searchBanks(dir, 'u.b.a')[0].bank.name,
    'United Bank for Africa',
  );
});

test('a misspelling matches nothing', () => {
  assert.deepEqual(searchBanks(dir, 'gtbnk zz'), []);
});

test('marks sit on the original name, even after accents and punctuation', () => {
  const accented = arrangeBanks([
    { code: '1', name: 'Société (Générale) Bank' },
  ]);
  const [match] = searchBanks(accented, 'gener');
  // S-o-c-i-é-t-é, space, (, then G at 9: "Génér" is [9, 14).
  assert.deepEqual(match.marks, [[9, 14]]);
});

test('the live count reads naturally', () => {
  assert.equal(matchCountText(1, 'gtb'), '1 bank matches');
  assert.equal(matchCountText(4, 'b'), '4 banks match');
  assert.equal(
    matchCountText(0, ' gtbnk zz '),
    'No bank matches "gtbnk zz". Check the spelling, or try the bank’s full name.',
  );
});

test('a highlight covers letters and digits only, never a bracket or a space', () => {
  const [opay] = searchBanks(dir, 'opay');
  // "Paycom (OPay)": O-P-a-y is [8, 12); the ")" after it is not underlined.
  assert.deepEqual(opay.marks, [[8, 12]]);
  const amp = arrangeBanks([{ code: '1', name: 'Eko & Sons Bank' }]);
  // "&" reads as "and"; the space after it is not underlined.
  assert.deepEqual(searchBanks(amp, 'and')[0].marks, [[4, 5]]);
});

test('combining accents belong to their letter, as normalizeBankText reads them', () => {
  // Ẹ̀kọ́ written with combining marks: E, U+0323, U+0300, k, o, U+0323, U+0301.
  const name = 'E\u0323\u0300ko\u0323\u0301 Bank';
  const eko = arrangeBanks([{ code: '1', name }]);
  const [match] = searchBanks(eko, 'eko');
  assert.equal(match.bank.name, name);
  // The underline runs over the whole word, marks included, and stops before the space.
  assert.deepEqual(match.marks, [[0, 7]]);
});
