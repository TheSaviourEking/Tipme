import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Money-safety proofs (withdraw-and-audit plan, carried over from states Task 12): the only
// reassuring money lines on Withdraw are the ones the code proves, and only where it proves them.
const src = fileURLToPath(new URL('../src', import.meta.url));
const VIEW = 'app/dashboard/withdraw/withdraw-view.tsx';
const view = readFileSync(join(src, VIEW), 'utf8');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

/** The source from `start` to the first `end` after it (inclusive), or null. */
function between(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `no ${end} after ${start}`);
  return text.slice(from, to + end.length);
}

test('“back in your balance” appears only on Withdraw and in the design-system specimen', () => {
  const found = sourceFiles(src)
    .filter((path) => /back in your balance/i.test(readFileSync(path, 'utf8')))
    .map((path) => relative(src, path).split(sep).join('/'))
    .sort();
  for (const path of found)
    assert.ok(
      [VIEW, 'app/design-system/states-specimen.tsx'].includes(path),
      `${path} says “back in your balance”`,
    );
});

/** The failed row's own line: from `row.state === 'failed' && (` to the `)}` after its `</p>`. */
const FAILED_GUARD = "row.state === 'failed' && (";
function failedGuard() {
  const from = view.indexOf(FAILED_GUARD);
  if (from === -1) return null;
  const close = view.indexOf('</p>', from);
  assert.notEqual(close, -1, 'the failed line is one paragraph');
  const to = view.indexOf(')}', close);
  assert.doesNotMatch(
    view.slice(close + '</p>'.length, to),
    /<|\{/,
    'nothing else is guarded',
  );
  return { from, to };
}

test('on Withdraw, a balance line or a safe line is only in the failed row', () => {
  // Every such line sits under `case 'failed':` in describe(), before the next case, or inside
  // the ledger's one `row.state === 'failed' && (…)` expression.
  const guard = failedGuard();
  for (const pattern of [/back in your balance/gi, /\bsafe=/g]) {
    for (const match of view.matchAll(pattern)) {
      const before = view.slice(0, match.index);
      const lastCase = [...before.matchAll(/case '([a-z_]+)':/g)].at(-1);
      const describeEnd = view.indexOf('function History');
      const inDescribe =
        lastCase && lastCase[1] === 'failed' && match.index < describeEnd;
      const inGuard =
        guard !== null && match.index > guard.from && match.index < guard.to;
      assert.ok(
        inDescribe || inGuard,
        `${match[0]} at ${match.index} is outside the failed row`,
      );
    }
  }
});

test('“Back in your balance” is written only for a failed row, once, with that row’s amount', () => {
  const lines = [...view.matchAll(/Back in your balance:/g)];
  assert.equal(lines.length, 1, 'one “Back in your balance:” line');
  const guard = failedGuard();
  assert.ok(guard, `the line is guarded by ${FAILED_GUARD}`);
  assert.equal(
    view.indexOf(FAILED_GUARD, guard.from + 1),
    -1,
    'one failed guard',
  );
  const expression = view.slice(guard.from, guard.to);
  assert.match(
    expression,
    /Back in your balance: \{formatNaira\(row\.amountMinor\)\}/,
  );
  assert.ok(lines[0].index > guard.from && lines[0].index < guard.to);
});

test('the unconfirmed slip carries no safe line and no money words', () => {
  const slip = between(view, '<Slip tone="unsure"', '</Slip>');
  assert.ok(slip, 'withdraw-view.tsx renders an unsure slip');
  assert.doesNotMatch(slip, /\bsafe=/);
  assert.doesNotMatch(slip, /money|balance|paid|safe/i);
});

test('the instrument carries no reassurance', () => {
  const meter = between(view, 'className="withdraw__meter"', '</section>');
  assert.ok(meter, 'withdraw-view.tsx renders the instrument');
  assert.doesNotMatch(meter, /safe|protected|guarantee/i);
});

test('Withdraw shows no Notice', () => {
  assert.doesNotMatch(view, /<Notice\b/);
  assert.doesNotMatch(view, /\bNotice\b[^.]*from '@tipme\/ui'/);
});
