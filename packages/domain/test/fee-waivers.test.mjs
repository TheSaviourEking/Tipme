import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FEE_WAIVED_VERSION_INFIX,
  FEE_WAIVER_FEES,
  FEE_WAIVER_KINDS,
  FEE_WAIVER_MAX_AHEAD_MONTHS,
  FEE_WAIVER_PAYERS,
  currentRuleOfKey,
  endOfLagosDayIso,
  feeWaiverShapeProblem,
  feeWaiverWindow,
  lagosMonthStart,
  lastCoveredLagosDate,
  resolveFeeWaiver,
  untilWords,
  waivedFeeVersion,
} from '../dist/index.js';

const d = (iso) => new Date(iso);
const NOW = d('2026-11-24T12:00:00Z');
let n = 0;
const rule = (o) => ({
  id: `r${++n}`,
  scope: 'kind',
  kind: 'individual',
  accountId: null,
  fee: 'tip',
  payer: 'tipme',
  startsAt: d('2026-11-01T00:00:00Z'),
  endsAt: null,
  createdAt: d('2026-11-01T00:00:00Z'),
  ...o,
});
const acct = (o) => rule({ scope: 'account', accountId: 'a1', ...o });

test('constants', () => {
  assert.deepEqual([...FEE_WAIVER_KINDS], ['individual', 'business', 'giving']);
  assert.deepEqual([...FEE_WAIVER_FEES], ['tip', 'withdrawal']);
  assert.deepEqual([...FEE_WAIVER_PAYERS], ['tipme', 'account', 'inherit']);
  assert.equal(FEE_WAIVER_MAX_AHEAD_MONTHS, 24);
  assert.equal(FEE_WAIVED_VERSION_INFIX, '-waived-');
  assert.equal(
    waivedFeeVersion('v3-free-500bps', 'abc'),
    'v3-free-500bps-waived-abc',
  );
});

test('an account rule beats a kind rule', () => {
  const k = rule({ payer: 'account' });
  const a = acct({ payer: 'tipme' });
  assert.deepEqual(
    resolveFeeWaiver({ accountRows: [a], kindRows: [k], now: NOW }),
    { payer: 'tipme', ruleId: a.id, endsAt: null },
  );
});

test('payer account on the account opts it out of a kind-wide waiver', () => {
  const k = rule({ payer: 'tipme' });
  const a = acct({ payer: 'account' });
  const r = resolveFeeWaiver({ accountRows: [a], kindRows: [k], now: NOW });
  assert.equal(r.payer, 'default');
  assert.equal(r.ruleId, null);
});

test('inherit follows the kind rule', () => {
  const end = d('2027-01-31T23:00:00Z');
  const k = rule({ payer: 'tipme', endsAt: end });
  const a = acct({ payer: 'inherit' });
  assert.deepEqual(
    resolveFeeWaiver({ accountRows: [a], kindRows: [k], now: NOW }),
    { payer: 'tipme', ruleId: k.id, endsAt: end },
  );
  const k2 = rule({ payer: 'account' });
  assert.equal(
    resolveFeeWaiver({ accountRows: [a], kindRows: [k2], now: NOW }).payer,
    'default',
  );
});

test('no rules is default', () => {
  assert.deepEqual(
    resolveFeeWaiver({ accountRows: [], kindRows: [], now: NOW }),
    { payer: 'default', ruleId: null, endsAt: null },
  );
});

test('starts_at equal to now is in force; ends_at equal to now is not', () => {
  assert.equal(currentRuleOfKey([rule({ startsAt: NOW })], NOW) !== null, true);
  assert.equal(currentRuleOfKey([rule({ endsAt: NOW })], NOW), null);
  assert.notEqual(
    currentRuleOfKey([rule({ endsAt: d('2026-11-24T12:00:00.001Z') })], NOW),
    null,
  );
});

test('an upcoming row does not replace the current one until it starts', () => {
  const cur = rule({ startsAt: d('2026-11-01T00:00:00Z') });
  const next = rule({ startsAt: d('2026-12-01T00:00:00Z'), payer: 'account' });
  assert.equal(currentRuleOfKey([cur, next], NOW).id, cur.id);
  assert.equal(
    currentRuleOfKey([cur, next], d('2026-12-01T00:00:00Z')).id,
    next.id,
  );
  assert.equal(currentRuleOfKey([next], NOW), null);
});

test('a newer row that has ended leaves the key with no rule, never the older one', () => {
  const open = rule({ startsAt: d('2026-10-01T00:00:00Z') });
  const ended = rule({
    startsAt: d('2026-11-10T00:00:00Z'),
    endsAt: d('2026-11-20T00:00:00Z'),
  });
  assert.equal(currentRuleOfKey([open, ended], NOW), null);
  assert.equal(currentRuleOfKey([ended, open], NOW), null);
  assert.equal(
    resolveFeeWaiver({ accountRows: [], kindRows: [open, ended], now: NOW })
      .payer,
    'default',
  );
});

test('same starts_at: the later created_at wins', () => {
  const a = rule({ createdAt: d('2026-11-02T00:00:00Z'), payer: 'tipme' });
  const b = rule({ createdAt: d('2026-11-03T00:00:00Z'), payer: 'account' });
  assert.equal(currentRuleOfKey([a, b], NOW).id, b.id);
  assert.equal(currentRuleOfKey([b, a], NOW).id, b.id);
});

test('shape: valid and refused combinations', () => {
  const ok = {
    scope: 'kind',
    kind: 'individual',
    fee: 'tip',
    payer: 'tipme',
    hasAccount: false,
  };
  assert.equal(feeWaiverShapeProblem(ok), null);
  assert.equal(
    feeWaiverShapeProblem({
      ...ok,
      scope: 'account',
      hasAccount: true,
      payer: 'inherit',
    }),
    null,
  );
  assert.equal(
    feeWaiverShapeProblem({ ...ok, kind: 'business', fee: 'withdrawal' }),
    null,
  );
  assert.equal(
    typeof feeWaiverShapeProblem({ ...ok, payer: 'inherit' }),
    'string',
  ); // inherit on a kind rule
  assert.equal(
    typeof feeWaiverShapeProblem({ ...ok, kind: 'business' }),
    'string',
  ); // tip for business
  assert.equal(
    typeof feeWaiverShapeProblem({
      ...ok,
      kind: 'giving',
      scope: 'account',
      hasAccount: true,
    }),
    'string',
  ); // giving account scope
  assert.equal(
    typeof feeWaiverShapeProblem({
      ...ok,
      scope: 'account',
      hasAccount: false,
    }),
    'string',
  ); // account scope without an account
  assert.equal(
    typeof feeWaiverShapeProblem({ ...ok, scope: 'kind', hasAccount: true }),
    'string',
  );
});

test('window: a start in the past becomes now (W3)', () => {
  assert.deepEqual(
    feeWaiverWindow({
      requestedStart: d('2026-11-01T00:00:00Z'),
      endsAt: null,
      now: NOW,
    }),
    { startsAt: NOW, endsAt: null },
  );
  assert.deepEqual(
    feeWaiverWindow({ requestedStart: null, endsAt: null, now: NOW }),
    {
      startsAt: NOW,
      endsAt: null,
    },
  );
  const future = d('2026-12-01T00:00:00Z');
  assert.equal(
    feeWaiverWindow({
      requestedStart: future,
      endsAt: null,
      now: NOW,
    }).startsAt.getTime(),
    future.getTime(),
  );
});

test('window: an end at or before the start is refused', () => {
  assert.equal(
    feeWaiverWindow({ requestedStart: null, endsAt: NOW, now: NOW }),
    'endsAt',
  );
  assert.equal(
    feeWaiverWindow({
      requestedStart: null,
      endsAt: d('2026-11-01T00:00:00Z'),
      now: NOW,
    }),
    'endsAt',
  );
  const s = d('2026-12-01T00:00:00Z');
  assert.equal(
    feeWaiverWindow({ requestedStart: s, endsAt: s, now: NOW }),
    'endsAt',
  );
  assert.notEqual(
    feeWaiverWindow({
      requestedStart: s,
      endsAt: d('2026-12-01T00:00:00.001Z'),
      now: NOW,
    }),
    'endsAt',
  );
});

test('window: an end 24 months ahead is allowed, a millisecond more is refused', () => {
  const max = d('2028-11-24T12:00:00Z');
  assert.deepEqual(
    feeWaiverWindow({ requestedStart: null, endsAt: max, now: NOW }),
    {
      startsAt: NOW,
      endsAt: max,
    },
  );
  assert.equal(
    feeWaiverWindow({
      requestedStart: null,
      endsAt: new Date(max.getTime() + 1),
      now: NOW,
    }),
    'endsAt',
  );
  assert.equal(
    feeWaiverWindow({
      requestedStart: max,
      endsAt: null,
      now: NOW,
    }).startsAt.getTime(),
    max.getTime(),
  );
  assert.equal(
    feeWaiverWindow({
      requestedStart: new Date(max.getTime() + 1),
      endsAt: null,
      now: NOW,
    }),
    'startsAt',
  );
});

test('window: month arithmetic clamps to the month end', () => {
  const now = d('2028-02-29T10:00:00Z');
  const max = d('2030-02-28T10:00:00Z');
  assert.notEqual(
    feeWaiverWindow({ requestedStart: null, endsAt: max, now }),
    'endsAt',
  );
  assert.equal(
    feeWaiverWindow({
      requestedStart: null,
      endsAt: new Date(max.getTime() + 1),
      now,
    }),
    'endsAt',
  );
});

test('a waiver ending at the start of 1 Feb Lagos reads "until 31 Jan"', () => {
  const endsAt = d('2027-01-31T23:00:00Z'); // 1 Feb 00:00 WAT
  assert.equal(lastCoveredLagosDate(endsAt), '2027-01-31');
  assert.equal(untilWords(endsAt, d('2027-01-10T00:00:00Z')), 'until 31 Jan');
  // late on 31 Jan Lagos (UTC 22:30) is still the 31st
  assert.equal(
    lastCoveredLagosDate(d('2027-01-31T22:59:59.999Z')),
    '2027-01-31',
  );
  assert.equal(
    lastCoveredLagosDate(d('2027-01-31T23:00:00.001Z')),
    '2027-02-01',
  );
});

test('untilWords adds the year when it is not the current Lagos year', () => {
  const endsAt = d('2027-01-31T23:00:00Z');
  assert.equal(
    untilWords(endsAt, d('2026-11-24T12:00:00Z')),
    'until 31 Jan 2027',
  );
  // 31 Dec 23:30 UTC 2026 is already 1 Jan 2027 in Lagos
  assert.equal(untilWords(endsAt, d('2026-12-31T23:30:00Z')), 'until 31 Jan');
  assert.equal(
    untilWords(d('2026-12-31T23:00:00Z'), d('2026-12-31T22:30:00Z')),
    'until 31 Dec',
  );
  assert.equal(
    untilWords(d('2027-01-01T23:00:00Z'), d('2026-12-31T22:30:00Z')),
    'until 1 Jan 2027',
  );
});

test('endOfLagosDayIso round-trips with lastCoveredLagosDate', () => {
  assert.equal(endOfLagosDayIso('2027-01-31'), '2027-01-31T23:00:00.000Z');
  assert.equal(endOfLagosDayIso('2026-12-31'), '2026-12-31T23:00:00.000Z');
  for (const date of ['2027-01-31', '2026-12-31', '2028-02-29', '2026-11-24']) {
    assert.equal(lastCoveredLagosDate(new Date(endOfLagosDayIso(date))), date);
  }
  assert.throws(() => endOfLagosDayIso('31 Jan'));
});

test('lagosMonthStart is the first instant of the Lagos month', () => {
  const iso = (s) => lagosMonthStart(d(s)).toISOString();
  assert.equal(iso('2026-11-24T12:00:00Z'), '2026-10-31T23:00:00.000Z');
  // 00:30 UTC on 1 Nov is 01:30 Lagos on 1 Nov
  assert.equal(iso('2026-11-01T00:30:00Z'), '2026-10-31T23:00:00.000Z');
  // 23:30 UTC on 30 Nov is already 00:30 on 1 Dec in Lagos
  assert.equal(iso('2026-11-30T23:30:00Z'), '2026-11-30T23:00:00.000Z');
  // 22:59:59.999 UTC on 31 Oct is still 31 Oct in Lagos
  assert.equal(iso('2026-10-31T22:59:59.999Z'), '2026-09-30T23:00:00.000Z');
  assert.equal(iso('2026-10-31T23:00:00Z'), '2026-10-31T23:00:00.000Z');
  assert.equal(iso('2026-12-31T23:30:00Z'), '2026-12-31T23:00:00.000Z');
});
