import { withdrawalMinimumMinor } from './fees.js';

/**
 * Splits one withdrawal across the payment providers that hold the owner's money, using as few
 * payouts as possible. `capsMinor` is what each provider can pay now, in drain order.
 *
 * Rules: the parts sum to the amount; 0 <= part <= cap; every non-zero part is at least the
 * withdrawal minimum or empties its provider (equals its cap). Returns null when the amount is
 * zero, above the total, or cannot be split within those rules.
 */
export function allocateWithdrawal(
  amountMinor: bigint,
  capsMinor: readonly bigint[],
  minimumMinor: bigint = withdrawalMinimumMinor(),
): bigint[] | null {
  if (
    amountMinor < 0n ||
    minimumMinor < 0n ||
    capsMinor.some((cap) => cap < 0n)
  ) {
    throw new RangeError('amount, caps and minimum must not be negative');
  }
  return (
    drainInOrder(amountMinor, capsMinor, minimumMinor) ??
    searchSubsets(amountMinor, capsMinor, minimumMinor)
  );
}

/** The first choice: one provider alone, else drain in order, folding a too-small last part. */
function drainInOrder(
  amountMinor: bigint,
  capsMinor: readonly bigint[],
  minimumMinor: bigint,
): bigint[] | null {
  const total = capsMinor.reduce((sum, cap) => sum + cap, 0n);
  if (amountMinor <= 0n || amountMinor > total) return null;

  const parts = capsMinor.map(() => 0n);

  // One provider that covers it carries all of it: one payout. First in drain order. An amount
  // under the minimum is only valid when it empties that provider.
  const single = capsMinor.findIndex(
    (cap) =>
      cap >= amountMinor &&
      (amountMinor >= minimumMinor || cap === amountMinor),
  );
  if (single !== -1) {
    parts[single] = amountMinor;
    return parts;
  }

  // Otherwise drain in order.
  let remaining = amountMinor;
  capsMinor.forEach((cap, i) => {
    const take = cap < remaining ? cap : remaining;
    parts[i] = take;
    remaining -= take;
  });

  // A last part under the minimum is fine only if it empties its provider; otherwise raise it by
  // taking less from the parts before it (each may drop to the minimum, no lower).
  const last = parts.findLastIndex((part) => part > 0n);
  const lastPart = parts[last] as bigint;
  const lastCap = capsMinor[last] as bigint;
  if (lastPart < minimumMinor && lastPart < lastCap) {
    const target = minimumMinor < lastCap ? minimumMinor : lastCap;
    let need = target - lastPart;
    for (let j = last - 1; j >= 0 && need > 0n; j--) {
      const spare = (parts[j] as bigint) - minimumMinor;
      const give = spare > 0n ? (need < spare ? need : spare) : 0n;
      parts[j] = (parts[j] as bigint) - give;
      need -= give;
    }
    if (need > 0n) return null;
    parts[last] = target;
  }
  return parts;
}

/**
 * The fallback when draining in order dead-ends: try provider subsets, fewest providers first and
 * the earliest in drain order among those. Within a subset every part sits in [min(M, cap), cap],
 * earlier providers carrying as much as they can so the later parts are as small as legal.
 */
function searchSubsets(
  amountMinor: bigint,
  capsMinor: readonly bigint[],
  minimumMinor: bigint,
): bigint[] | null {
  const usable = capsMinor.flatMap((cap, index) => (cap > 0n ? [index] : []));
  const low = (i: number): bigint => {
    const cap = capsMinor[i] as bigint;
    return minimumMinor < cap ? minimumMinor : cap;
  };

  const tryOne = (subset: number[]): bigint[] | null => {
    let lowRest = subset.reduce((sum, i) => sum + low(i), 0n);
    let capRest = subset.reduce((sum, i) => sum + (capsMinor[i] as bigint), 0n);
    if (amountMinor < lowRest || amountMinor > capRest) return null;
    const parts = capsMinor.map(() => 0n);
    let remaining = amountMinor;
    for (const i of subset) {
      const cap = capsMinor[i] as bigint;
      lowRest -= low(i);
      capRest -= cap;
      const room = remaining - lowRest;
      const part = cap < room ? cap : room;
      parts[i] = part;
      remaining -= part;
    }
    return remaining === 0n ? parts : null;
  };

  // Combinations of `size` usable indexes, in lexicographic (drain) order.
  const search = (
    size: number,
    start: number,
    chosen: number[],
  ): bigint[] | null => {
    if (chosen.length === size) return tryOne(chosen);
    for (let k = start; k < usable.length; k++) {
      const found = search(size, k + 1, [...chosen, usable[k] as number]);
      if (found) return found;
    }
    return null;
  };

  for (let size = 1; size <= usable.length; size++) {
    const found = search(size, 0, []);
    if (found) return found;
  }
  return null;
}

/** How many payouts the withdrawal needs (non-zero parts), or null when it cannot be split. */
export function withdrawalPartCount(
  amountMinor: bigint,
  capsMinor: readonly bigint[],
  minimumMinor: bigint = withdrawalMinimumMinor(),
): number | null {
  const parts = allocateWithdrawal(amountMinor, capsMinor, minimumMinor);
  return parts === null ? null : parts.filter((part) => part > 0n).length;
}

/** What each provider carries of `totalMinor` drawn in drain order (the quote's takes, spec §5). */
export function drainTakes(
  capsMinor: readonly bigint[],
  totalMinor: bigint,
): bigint[] {
  let remaining = totalMinor;
  return capsMinor.map((cap) => {
    const take = cap < remaining ? cap : remaining;
    remaining -= take;
    return take;
  });
}

/**
 * How the request splits an amount across the providers: `allocateWithdrawal`, and, to take all
 * that can be taken when only the ledger runs out, each provider's take in drain order. Null when
 * it can't be split.
 */
export function requestAllocation(
  amountMinor: bigint,
  capsMinor: readonly bigint[],
  withdrawableMinor: bigint,
): bigint[] | null {
  return (
    allocateWithdrawal(amountMinor, capsMinor) ??
    (amountMinor === withdrawableMinor
      ? allocateWithdrawal(
          amountMinor,
          drainTakes(capsMinor, withdrawableMinor),
        )
      : null)
  );
}

/** The part that pays the one fee: the largest, the first in drain order among equals. */
export function feeCarrierIndex(partsMinor: readonly bigint[]): number {
  let best = -1;
  partsMinor.forEach((part, index) => {
    if (part > 0n && (best === -1 || part > (partsMinor[best] ?? 0n)))
      best = index;
  });
  return best;
}

/** A provider the quote read: what it can pay now, its transfer fee, and who would pay that fee. */
export interface WithdrawalFeePart {
  capMinor: bigint;
  feeMinor: bigint;
  feePaidBy: 'user' | 'tipme';
}

/**
 * The transfer fee on withdrawing `amountMinor`, and who pays it (Ruling R6): the fee of the
 * provider carrying the largest part, split exactly as the request splits it. Who pays can differ
 * by provider (an unused top-up is held at one provider only), so the screen asks this for the
 * amount typed and the request decides from the same part. Null when the amount can't be split.
 */
export function withdrawalFeeFor(
  amountMinor: bigint,
  parts: readonly WithdrawalFeePart[],
  withdrawableMinor: bigint,
): { feeMinor: bigint; feePaidBy: 'user' | 'tipme' } | null {
  if (amountMinor <= 0n || parts.length === 0) return null;
  const allocation = requestAllocation(
    amountMinor,
    parts.map((part) => part.capMinor),
    withdrawableMinor,
  );
  const carrier = allocation ? parts[feeCarrierIndex(allocation)] : undefined;
  return carrier
    ? { feeMinor: carrier.feeMinor, feePaidBy: carrier.feePaidBy }
    : null;
}
