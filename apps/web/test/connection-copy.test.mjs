import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONNECTION_COPY } from '../src/lib/connection-copy.ts';

// States plan, Task 17: the connection-failure strings, in one file, with the owner's answers to
// the plan's questions 1-4 (5 Nov 2026, docs/design/DECISION-LOG.md).
const src = fileURLToPath(new URL('../src', import.meta.url));
const copyFile = join(src, 'lib/connection-copy.ts');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

test('the connection copy records the owner’s approval, not a pending flag', () => {
  const text = readFileSync(copyFile, 'utf8');
  assert.doesNotMatch(text, /COPY AWAITING OWNER YES/);
  assert.match(text, /approved by the owner on 5 Nov 2026/i);
});

test('the owner’s answers are the words shown', () => {
  assert.equal(
    CONNECTION_COPY.signInDropped,
    'That didn’t go through. The connection dropped before your code reached us. Tap Continue again.',
  );
  assert.equal(
    CONNECTION_COPY.ourSide,
    'This is on our side. Try again in a minute.',
  );
  assert.equal(
    CONNECTION_COPY.ourSideTip,
    'This is on our side. You haven’t paid anything. Try again in a minute.',
  );
  assert.equal(
    CONNECTION_COPY.welcomeDropped,
    'That didn’t save. The connection dropped. Tap Continue to try again.',
  );
  assert.equal(
    CONNECTION_COPY.signInCodeUsed,
    'That code can’t be used now. Tap Send a new code.',
  );
  assert.equal(
    CONNECTION_COPY.tipOffline,
    'You’re offline. Connect to the internet and we’ll send your tip.',
  );
  assert.equal(
    CONNECTION_COPY.tipDropped,
    'Your tip didn’t go through. The connection dropped before it reached us. You haven’t paid anything. Tap Tip to send it again.',
  );
  assert.equal(
    CONNECTION_COPY.receiptNoAnswer,
    'We’ll check again in a moment.',
  );
  assert.equal(CONNECTION_COPY.receiptOffline, 'You’re offline.');
});

test('no connection string uses an em dash, and each ends with a full stop', () => {
  for (const [name, line] of Object.entries(CONNECTION_COPY)) {
    assert.doesNotMatch(line, /—/, name);
    assert.match(line, /\.$/, name);
  }
});

test('no connection string promises the account or the money is safe', () => {
  for (const [name, line] of Object.entries(CONNECTION_COPY))
    assert.doesNotMatch(line, /your money|account.*safe|money.*safe/i, name);
});

test('“You haven’t paid anything” is only in the tip form’s strings', () => {
  const saying = Object.entries(CONNECTION_COPY)
    .filter(([, line]) => /haven’t paid anything/.test(line))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(saying, ['ourSideTip', 'tipDropped']);
});

test('the connection copy is used only on the tip form, receipt, sign-in and welcome, never on withdraw', () => {
  const users = sourceFiles(src)
    .filter((file) => file !== copyFile)
    .filter((file) => /connection-copy/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(src, file).split(sep).join('/'))
    .sort();
  assert.deepEqual(users, [
    'app/dashboard/welcome/welcome-view.tsx',
    'app/tip/[tipId]/status-view.tsx',
    'components/account/email-code-form.tsx',
    'components/appreciation-form.tsx',
  ]);
  // The tip-only strings stay on the tip form.
  for (const file of users.filter((f) => !f.includes('appreciation-form')))
    assert.doesNotMatch(
      readFileSync(join(src, file), 'utf8'),
      /\b(ourSideTip|tipDropped|tipOffline)\b/,
      file,
    );
});
