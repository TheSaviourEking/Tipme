import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPS_APPROVAL_STALE_REASONS,
  SERIOUS_ACTION_WORDS,
  SERIOUS_ACTIONS,
} from '../../../packages/contracts/dist/index.js';
import {
  accessAdjustments,
  approveRefusal,
  answerOf,
  outcomeIsUnknown,
  refusalWords,
  STALE_WORDS,
  withFreshCode,
} from '../src/lib/ops-answers.ts';

const ok = (status, data) => ({ ok: true, status, data });
const no = (status, code, extra = {}) => ({
  ok: false,
  status,
  code,
  ...extra,
});

test('a 202 with a request reads as waiting, and says if it was already waiting', () => {
  assert.deepEqual(answerOf(ok(202, { requestId: 'r1' })), {
    kind: 'waiting',
    requestId: 'r1',
    repeat: false,
  });
  assert.deepEqual(answerOf(ok(202, { requestId: 'r1', repeat: true })), {
    kind: 'waiting',
    requestId: 'r1',
    repeat: true,
  });
});

test('email recovery answers 202 when it ran: only a request is waiting', () => {
  const answer = answerOf(ok(202, { outcome: 'code_sent' }));
  assert.equal(answer.kind, 'done');
  assert.equal(answer.actedAlone, false);
});

test('a 200 is done, and says when it was done alone', () => {
  assert.equal(answerOf(ok(200, { resolved: true })).actedAlone, false);
  assert.equal(
    answerOf(ok(200, { resolved: true, actedAlone: true })).actedAlone,
    true,
  );
});

test('a failure is refused, never done or waiting', () => {
  const answer = answerOf(no(409, 'ISSUE_RESOLVED'));
  assert.equal(answer.kind, 'refused');
  assert.equal(answer.code, 'ISSUE_RESOLVED');
});

test('asks for a code once, on that one refusal, and only then tries again', async () => {
  let sends = 0;
  let prompts = 0;
  const result = await withFreshCode(
    async () =>
      ++sends === 1 ? no(403, 'FRESH_CODE_REQUIRED') : ok(200, { done: true }),
    async () => {
      prompts += 1;
      return true;
    },
  );
  assert.equal(result.ok, true);
  assert.equal(sends, 2);
  assert.equal(prompts, 1);
});

test('no code, no second try; other answers never prompt', async () => {
  let sends = 0;
  const declined = await withFreshCode(
    async () => {
      sends += 1;
      return no(403, 'FRESH_CODE_REQUIRED');
    },
    async () => false,
  );
  assert.equal(declined.code, 'FRESH_CODE_REQUIRED');
  assert.equal(sends, 1);
  for (const answer of [ok(200, {}), no(403, 'FORBIDDEN'), no(0, 'NETWORK')]) {
    const result = await withFreshCode(
      async () => answer,
      async () => assert.fail('must not prompt'),
    );
    assert.equal(result, answer);
  }
});

test('every serious action, and every way a request can go stale, has words', () => {
  for (const action of SERIOUS_ACTIONS)
    assert.ok(SERIOUS_ACTION_WORDS[action], action);
  assert.ok(SERIOUS_ACTION_WORDS['money_issue.close']);
  for (const reason of OPS_APPROVAL_STALE_REASONS)
    assert.ok(STALE_WORDS[reason], reason);
});

test('approving during an outage reads as still waiting and retryable', () => {
  const answer = approveRefusal(no(503, 'DEPENDENCY_UNAVAILABLE'));
  assert.equal(answer.stillWaiting, true);
  assert.match(answer.text, /still waiting/i);
  assert.match(answer.text, /try again/i);
});

test('approving a request that concerns you, or has gone stale, says why', () => {
  assert.match(
    approveRefusal(no(403, 'APPROVAL_SUBJECT')).text,
    /concerns you/,
  );
  const stale = approveRefusal(
    no(409, 'APPROVAL_STALE', { reason: 'facts_changed' }),
  );
  assert.equal(stale.stillWaiting, false);
  assert.equal(stale.text, STALE_WORDS.facts_changed);
  assert.match(approveRefusal(no(400, 'CODE_INVALID')).text, /code/i);
  assert.equal(approveRefusal(no(400, 'CODE_INVALID')).stillWaiting, true);
});

test('refusals on money closes are specific; the server’s fixed words are the fallback', () => {
  assert.match(refusalWords(no(429, 'RATE_LIMITED')), /Nothing changed/);
  assert.match(refusalWords(no(409, 'ISSUE_RESOLVED')), /already resolved/);
  assert.match(refusalWords(no(409, 'PAYOUT_CHANGED')), /Nothing was done/);
  assert.match(refusalWords(no(403, 'FRESH_CODE_REQUIRED')), /code/);
  assert.equal(
    refusalWords(no(409, 'LAST_OWNER', { message: 'Server words.' })),
    'Server words.',
  );
  assert.match(refusalWords(no(0, 'NETWORK')), /no answer/i);
});

test('a 5xx or an unmapped answer never says nothing changed: the result is unknown', () => {
  for (const answer of [
    no(500, 'INTERNAL_ERROR'),
    no(502, 'INTERNAL_ERROR'),
    no(0, 'NETWORK'),
    no(503, 'DEPENDENCY_UNAVAILABLE'),
    no(400, 'SOMETHING_NEW'),
  ]) {
    assert.doesNotMatch(refusalWords(answer), /nothing changed/i, answer.code);
    assert.match(refusalWords(answer), /reload/i, answer.code);
  }
  for (const answer of [no(500, 'INTERNAL_ERROR'), no(0, 'NETWORK')])
    assert.equal(outcomeIsUnknown(answer), true);
  assert.equal(outcomeIsUnknown(no(409, 'LAST_OWNER')), false);
  const lost = approveRefusal(no(500, 'INTERNAL_ERROR'));
  assert.equal(lost.unknown, true);
  assert.doesNotMatch(lost.text, /nothing|not approved/i);
});

test('the words live in the catalogue, so emails and screens say the same', () => {
  for (const action of SERIOUS_ACTIONS)
    assert.ok(SERIOUS_ACTION_WORDS[action], action);
});

test('ticks become a person’s additions and removals against their role', () => {
  assert.deepEqual(accessAdjustments(['a', 'b'], ['b', 'c']), {
    additions: ['c'],
    removals: ['a'],
  });
  assert.deepEqual(accessAdjustments(['a'], ['a']), {
    additions: [],
    removals: [],
  });
});

test('each username refusal has plain words, with no em dash', () => {
  const words = (code, context) =>
    refusalWords(
      { status: code === 'USERNAME_NOT_RESERVED' ? 404 : 409, code },
      context,
    );
  assert.equal(
    words('USERNAME_BUILT_IN'),
    'TipMe’s own list already reserves this',
  );
  assert.equal(words('USERNAME_RESERVED'), 'This username is already reserved');
  assert.equal(
    words('USERNAME_HELD_BY_PAGE', { handle: 'kemi' }),
    'This is @kemi’s username. To take it, ask to take it back.',
  );
  assert.equal(words('USERNAME_NOT_RESERVED'), 'This username isn’t reserved');
  for (const code of [
    'USERNAME_BUILT_IN',
    'USERNAME_RESERVED',
    'USERNAME_HELD_BY_PAGE',
    'USERNAME_NOT_RESERVED',
  ]) {
    const text = words(code);
    assert.ok(!text.includes('—'), code);
    assert.ok(!text.includes('refused, and we don’t have words'), code);
  }
  // Without the page's handle it still says what to do, never "@undefined".
  assert.ok(!words('USERNAME_HELD_BY_PAGE').includes('@'));
});

test('each take-back refusal and activity has plain words, with no em dash', async () => {
  const { STAFF_ACTIVITY_WORDS } = await import('../src/lib/ops-answers.ts');
  const words = (code) => refusalWords({ status: 409, code });
  assert.equal(
    words('TAKE_BACK_OPEN'),
    'This username already has a take-back under way',
  );
  assert.equal(
    words('TAKE_BACK_CLOSED'),
    'This take-back has already finished',
  );
  assert.equal(
    refusalWords({ status: 404, code: 'TAKE_BACK_NOT_FOUND' }),
    'We couldn’t find that take-back',
  );
  for (const action of [
    'username.take_back_started',
    'username.take_back_done',
    'username.released',
  ])
    assert.ok(STAFF_ACTIVITY_WORDS[action], action);
  for (const text of [
    words('TAKE_BACK_OPEN'),
    words('TAKE_BACK_CLOSED'),
    STAFF_ACTIVITY_WORDS['username.take_back_started'],
  ])
    assert.equal(/[\u2013\u2014]/.test(text), false);
});

test('the changelog refusals say nothing changed, and what to do', () => {
  const words = (code, status = 409) => refusalWords({ status, code });
  assert.match(
    words('CHANGELOG_EDITED_ELSEWHERE'),
    /someone else.*Nothing changed/is,
  );
  assert.match(words('APPROVAL_NO_APPROVER'), /Nobody who can approve/);
  assert.match(words('CHANGELOG_NOT_FOUND', 404), /no changelog entry/i);
  assert.match(
    words('CHANGELOG_TEXT_NOT_ALLOWED', 422),
    /can’t be shown to users/,
  );
});
