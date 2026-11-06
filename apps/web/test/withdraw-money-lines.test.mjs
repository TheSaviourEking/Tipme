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

test('on Withdraw, a balance line or a safe line is only in the failed row', () => {
  // Every such line sits under `case 'failed':` in describe(), before the next case.
  for (const pattern of [/back in your balance/gi, /\bsafe=/g]) {
    for (const match of view.matchAll(pattern)) {
      const before = view.slice(0, match.index);
      const lastCase = [...before.matchAll(/case '([a-z_]+)':/g)].at(-1);
      const describeEnd = view.indexOf('function History');
      assert.ok(
        lastCase && lastCase[1] === 'failed' && match.index < describeEnd,
        `${match[0]} at ${match.index} is outside the failed row`,
      );
    }
  }
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
