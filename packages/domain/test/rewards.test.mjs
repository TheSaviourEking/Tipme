import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cashBonusAmount,
  feeFreeAllowed,
  FEE_POLICY_V1,
  priceTip,
  REWARDS,
} from '../dist/index.js';

const NO_LIMIT = 10n ** 15n;

test('a cash bonus is half the fees since the last bonus, within the lifetime cap and the budget', () => {
  const bonus = (feesSince, lifetimeFees, lifetimeCost, budget) =>
    cashBonusAmount({
      feesSinceLastCashMinor: feesSince,
      lifetimeFeesMinor: lifetimeFees,
      lifetimeRewardCostMinor: lifetimeCost,
      budgetRemainingMinor: budget,
    });
  assert.equal(bonus(10000n, 20000n, 0n, NO_LIMIT), 5000n);
  assert.equal(bonus(10000n, 10000n, 4000n, NO_LIMIT), 1000n);
  assert.equal(bonus(10000n, 20000n, 0n, 300n), 300n);
  assert.equal(bonus(10000n, 10000n, 9000n, NO_LIMIT), 0n);
  assert.equal(bonus(0n, 0n, 0n, NO_LIMIT), 0n);
});

test('fee-free pricing waives TipMe’s whole 10%: the recipient receives the full tip', () => {
  const free = priceTip(200000n, FEE_POLICY_V1, { feeFree: true });
  assert.equal(free.platformFeeMinor, 0n);
  // Processing is then TipMe's own cost (an unrecovered provider fee in the ledger).
  assert.equal(free.providerFeeMinor, 0n);
  assert.equal(free.recipientNetMinor, 200000n);
  assert.equal(
    free.tipMinor,
    free.platformFeeMinor + free.providerFeeMinor + free.recipientNetMinor,
  );
});

test('a fee-free tip is allowed only with a credit and within the lifetime cap', () => {
  assert.equal(
    feeFreeAllowed({
      credits: 0,
      waivedFeeMinor: 100n,
      lifetimeFeesMinor: 100000n,
      lifetimeRewardCostMinor: 0n,
    }),
    false,
  );
  assert.equal(
    feeFreeAllowed({
      credits: 2,
      waivedFeeMinor: 100n,
      lifetimeFeesMinor: 100000n,
      lifetimeRewardCostMinor: 0n,
    }),
    true,
  );
  assert.equal(
    feeFreeAllowed({
      credits: 2,
      waivedFeeMinor: 100n,
      lifetimeFeesMinor: 1000n,
      lifetimeRewardCostMinor: 450n,
    }),
    false,
  );
});

test('whatever happens, TipMe never gives back more than half the fees a recipient earned it', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let run = 0; run < 1000; run += 1) {
    let lifetimeFees = 0n;
    let feesSince = 0n;
    let cost = 0n;
    let credits = 0;
    let budget = BigInt(Math.floor(random() * 200000));
    for (let step = 0; step < 60; step += 1) {
      const fee = BigInt(Math.floor(random() * 20000) + 5);
      const roll = random();
      if (roll < 0.15) credits += 5;
      if (
        roll < 0.6 &&
        feeFreeAllowed({
          credits,
          waivedFeeMinor: fee,
          lifetimeFeesMinor: lifetimeFees,
          lifetimeRewardCostMinor: cost,
        })
      ) {
        credits -= 1;
        cost += fee;
      } else {
        lifetimeFees += fee;
        feesSince += fee;
      }
      if (roll > 0.9) {
        const cash = cashBonusAmount({
          feesSinceLastCashMinor: feesSince,
          lifetimeFeesMinor: lifetimeFees,
          lifetimeRewardCostMinor: cost,
          budgetRemainingMinor: budget,
        });
        assert.ok(cash >= 0n);
        cost += cash;
        budget -= cash;
        feesSince = 0n;
      }
      assert.ok(
        cost * 10000n <= lifetimeFees * REWARDS.lifetimeCapBps,
        `run ${run} step ${step}`,
      );
      assert.ok(budget >= 0n);
    }
  }
});
