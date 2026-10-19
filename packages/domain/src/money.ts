/** Money is always integer minor units plus an ISO 4217 code. Never floating point. */
export interface Money {
  minor: bigint;
  currency: string;
}

// Upper bound keeps values far inside Postgres bigint and safe to format.
const MAX_MINOR = 9_007_199_254_740_991_000n;
const CURRENCY = /^[A-Z]{3}$/;

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';
}

export function assertCurrency(currency: string): void {
  if (!CURRENCY.test(currency))
    throw new RangeError('currency must be a 3-letter ISO 4217 code');
}

export function money(minor: bigint, currency: string): Money {
  assertCurrency(currency);
  if (minor < 0n || minor > MAX_MINOR)
    throw new RangeError('amount out of range');
  return { minor, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency)
    throw new CurrencyMismatchError('currencies differ');
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** Decimal string of minor units for JSON boundaries (JSON cannot carry bigint). */
export function formatMinor(minor: bigint): string {
  return minor.toString();
}
