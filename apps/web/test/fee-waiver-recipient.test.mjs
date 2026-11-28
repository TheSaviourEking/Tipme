import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEE_WAIVER_RECIPIENT_COPY } from '@tipme/contracts/copy';
import { tipsCoveredLine } from '../src/lib/fee-waiver-recipient.ts';

// Fee waivers (spec 2026-11-23 §7, W17): what a recipient reads while TipMe pays their fees.

const inJanuary = new Date('2027-01-10T12:00:00.000Z');

test('the dashboard line names the last day covered, the day picked and never the day after', () => {
  // A waiver whose last day is 31 Jan ends at the start of 1 Feb in Lagos.
  assert.equal(
    tipsCoveredLine({ endsAt: '2027-01-31T23:00:00.000Z' }, inJanuary),
    'TipMe is covering the fee on your tips until 31 Jan',
  );
  // From another year, the year is said too.
  assert.equal(
    tipsCoveredLine(
      { endsAt: '2027-01-31T23:00:00.000Z' },
      new Date('2026-12-20T12:00:00.000Z'),
    ),
    'TipMe is covering the fee on your tips until 31 Jan 2027',
  );
});

test('with no end date the line says no date; with no waiver there is no line', () => {
  assert.equal(
    tipsCoveredLine({ endsAt: null }, inJanuary),
    'TipMe is covering the fee on your tips',
  );
  assert.equal(tipsCoveredLine(null, inJanuary), null);
  // An older API (or a test's routed answer) without the field shows nothing.
  assert.equal(tipsCoveredLine(undefined, inJanuary), null);
});

test('the recipient’s fee words never name the payment partner', () => {
  const words = [
    tipsCoveredLine({ endsAt: null }, inJanuary),
    FEE_WAIVER_RECIPIENT_COPY.tipCovered,
    FEE_WAIVER_RECIPIENT_COPY.businessTransferFree,
    FEE_WAIVER_RECIPIENT_COPY.businessReceives,
  ].join(' ');
  assert.doesNotMatch(words, /bachs|mock|partner/i);
  assert.equal(
    FEE_WAIVER_RECIPIENT_COPY.tipCovered,
    'TipMe covered the fee on this tip.',
  );
  assert.equal(
    `${FEE_WAIVER_RECIPIENT_COPY.businessTransferFree} ${FEE_WAIVER_RECIPIENT_COPY.businessReceives} ₦1,800.`,
    'Transfer fee: Free. The business receives ₦1,800.',
  );
});
