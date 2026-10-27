import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, mergeDecision } from './pr-merge.mjs';

const openPr = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE' };
const check = (name, bucket) => ({ name, bucket });
const green = [
  check('static', 'pass'),
  check('security', 'pass'),
  check('integration', 'pass'),
  check('e2e', 'pass'),
  check('CodeRabbit', 'skipping'),
];

test('a PR merges only when it is open, ready, conflict-free and every check passed', () => {
  assert.deepEqual(mergeDecision({ pr: openPr, checks: green }), {
    ok: true,
    reasons: [],
  });
});

test('a failing, pending or cancelled check refuses the merge and names it', () => {
  const decision = mergeDecision({
    pr: openPr,
    checks: [
      ...green.filter((c) => c.name !== 'e2e' && c.name !== 'integration'),
      check('e2e', 'fail'),
      check('integration', 'pending'),
      check('Vercel', 'cancel'),
    ],
  });
  assert.equal(decision.ok, false);
  assert.deepEqual(decision.reasons, [
    'e2e: fail',
    'integration: pending',
    'Vercel: cancel',
  ]);
});

test('no checks, a draft, a closed PR or a conflict also refuse it', () => {
  assert.deepEqual(mergeDecision({ pr: openPr, checks: [] }).reasons, [
    'no CI checks have reported yet',
  ]);
  assert.deepEqual(
    mergeDecision({ pr: { ...openPr, isDraft: true }, checks: green }).reasons,
    ['the PR is a draft'],
  );
  assert.deepEqual(
    mergeDecision({ pr: { ...openPr, state: 'MERGED' }, checks: green })
      .reasons,
    ['the PR is MERGED, not open'],
  );
  assert.deepEqual(
    mergeDecision({
      pr: { ...openPr, mergeable: 'CONFLICTING' },
      checks: green,
    }).reasons,
    ['the PR has merge conflicts'],
  );
});

test('a refused merge never calls gh pr merge', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'view') return JSON.stringify(openPr);
    if (args[1] === 'checks') return JSON.stringify([check('e2e', 'fail')]);
    return '';
  };
  const log = [];
  const code = await main(['26'], { gh, log: (line) => log.push(line) });
  assert.equal(code, 1);
  assert.equal(
    calls.some((c) => c.startsWith('pr merge')),
    false,
  );
  assert.match(log.join('\n'), /e2e: fail/);
});

test('a green PR is merged with a merge commit', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'view') return JSON.stringify(openPr);
    if (args[1] === 'checks') return JSON.stringify(green);
    return '';
  };
  const code = await main(['26'], { gh, log: () => undefined });
  assert.equal(code, 0);
  assert.equal(calls.at(-1), 'pr merge 26 --merge');
});
