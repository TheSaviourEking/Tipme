import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COLLECT_COPY } from '@tipme/contracts';

// You collect (spec §10, plan Task 14): every recipient and supporter string comes from one
// constant, word for word as the spec writes it. The spec's table is read here, so a change to
// either side fails this test.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path) => readFileSync(`${repoRoot}/${path}`, 'utf8');

/** The quoted texts of §10's table, by its "Where" column. */
function specTable() {
  const spec = read('docs/superpowers/specs/2026-11-19-you-collect-design.md');
  const section = spec.slice(
    spec.indexOf('## 10. Copy'),
    spec.indexOf('## 11. '),
  );
  const rows = {};
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || !cells[2]?.startsWith('"')) continue;
    rows[cells[1]] = [...cells[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return rows;
}

/** Every string the constant can produce, with a sample value put in where one is taken. */
function everyString() {
  return Object.entries(COLLECT_COPY).map(([key, value]) => [
    key,
    typeof value === 'function' ? value('Ada') : value,
  ]);
}

test('collect copy is the spec’s, and never names the partner or says wallet, protected or insured', () => {
  const table = specTable();
  const expected = {
    'Dashboard, no bank yet': [COLLECT_COPY.dashboardNoBank],
    'Balance note': [COLLECT_COPY.balanceNote],
    'Withdraw, no bank': [
      COLLECT_COPY.withdrawNoBank,
      COLLECT_COPY.withdrawOwnName,
    ],
    'Name confirm': [COLLECT_COPY.nameConfirm('{BANK NAME}')],
    Checking: [COLLECT_COPY.checking],
    'Manual check': [COLLECT_COPY.manualCheck],
    'Name mismatch': [COLLECT_COPY.nameMismatch],
    Verified: [COLLECT_COPY.verified],
    'On its way': [COLLECT_COPY.onItsWay],
    'Reminder, day 7 / 21': [COLLECT_COPY.reminder('{amount}')],
    'Reminder, day 28': [COLLECT_COPY.reminderLast('{date}')],
    'Paused (recipient)': [COLLECT_COPY.pausedRecipient],
    'Paused (supporter)': [COLLECT_COPY.pausedSupporter('{Name}')],
    Receipt: [COLLECT_COPY.receipt('{Name}')],
    'First withdrawal cap': [COLLECT_COPY.firstWithdrawalCap('{amount}')],
    'Dispute hold': [COLLECT_COPY.disputeHold('{amount}')],
  };
  // Every row of the table, and nothing the table doesn't have.
  assert.deepEqual(table, expected);
  assert.equal(
    Object.keys(COLLECT_COPY).length,
    Object.values(expected).flat().length,
  );

  for (const [key, text] of everyString()) {
    assert.equal(typeof text, 'string', key);
    // The partner is never named (owner rule, 1 Nov 2026), and nothing implies a licence or a bank.
    assert.doesNotMatch(text, /bachs/i, key);
    assert.doesNotMatch(
      text,
      /wallet|protected|insured|account with TipMe|licen[cs]e|regulat/i,
      key,
    );
  }
});

test('the API’s mismatch words are the same as the form’s', () => {
  const filter = read('apps/api/src/http/api-exception.filter.ts');
  assert.ok(
    filter.includes(
      `NAME_MISMATCH:\n    ${JSON.stringify(COLLECT_COPY.nameMismatch)},`,
    ),
    'NAME_MISMATCH in api-exception.filter.ts',
  );
});

test('the strings that take a value put it where the spec does', () => {
  assert.equal(
    COLLECT_COPY.nameConfirm('ADA OKAFOR'),
    'Is this you? ADA OKAFOR',
  );
  assert.equal(
    COLLECT_COPY.pausedSupporter('Ada'),
    "Ada can't take tips right now. Please try again later.",
  );
  assert.equal(COLLECT_COPY.receipt('Ada'), 'Paid to TipMe for Ada');
  assert.equal(
    COLLECT_COPY.firstWithdrawalCap('₦20,000'),
    'New accounts can withdraw up to ₦20,000 the first time.',
  );
});
