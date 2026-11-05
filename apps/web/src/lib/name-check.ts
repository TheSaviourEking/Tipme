export type NameCheckOutcome =
  | { kind: 'found'; accountName: string }
  | { kind: 'not_found' }
  /** The API's error code, shown through the card's messageFor. */
  | { kind: 'failed'; code: string };
export type NameCheckView =
  /** No bank, or fewer than 10 digits. */
  { kind: 'waiting' } | { kind: 'checking' } | NameCheckOutcome;

/** `${bankCode}:${accountNumber}` once both are complete, else null. */
export function nameCheckKey(
  bankCode: string,
  accountNumber: string,
): string | null {
  return bankCode && /^\d{10}$/.test(accountNumber)
    ? `${bankCode}:${accountNumber}`
    : null;
}

/**
 * Every name check this card has made, by bank and number, so a pair is never checked twice
 * (the partner allows 10 a day). Mutable on purpose: it lives in a ref, so the check-or-not
 * decision is synchronous. The keys hold the full account number: never render or log them.
 */
export class NameChecks {
  readonly #outcomes = new Map<string, NameCheckOutcome>();
  readonly #inFlight = new Set<string>();

  /** True, and marks it in flight, only for a complete key with no outcome and no call in flight. */
  claim(key: string | null): key is string {
    if (key === null || this.#outcomes.has(key) || this.#inFlight.has(key))
      return false;
    this.#inFlight.add(key);
    return true;
  }

  finish(key: string, outcome: NameCheckOutcome): void {
    this.#inFlight.delete(key);
    this.#outcomes.set(key, outcome);
  }

  /** Only a failed outcome can be retried: it clears that outcome and claims the key again. */
  retry(key: string | null): key is string {
    if (key === null || this.#outcomes.get(key)?.kind !== 'failed')
      return false;
    this.#outcomes.delete(key);
    return this.claim(key);
  }

  view(key: string | null): NameCheckView {
    if (key === null) return { kind: 'waiting' };
    if (this.#inFlight.has(key)) return { kind: 'checking' };
    return this.#outcomes.get(key) ?? { kind: 'waiting' };
  }
}
