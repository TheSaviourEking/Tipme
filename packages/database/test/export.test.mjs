import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell } from '../dist/index.js';

test('CSV cells are quoted when needed and can never run as spreadsheet formulas', () => {
  assert.equal(csvCell('Ada'), 'Ada');
  assert.equal(csvCell('Okafor, Ada'), '"Okafor, Ada"');
  assert.equal(csvCell('She said "thanks"'), '"She said ""thanks"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  for (const lead of ['+1', '-1', '@sum', '\tx'])
    assert.equal(csvCell(lead).replace(/^"/, '').startsWith("'"), true, lead);
  assert.equal(csvCell('2000.00'), '2000.00');
});
