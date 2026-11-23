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
