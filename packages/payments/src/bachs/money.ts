const ISO_CURRENCY = /^[A-Z]{3}$/;
const DECIMAL_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

function fractionDigits(currency: string): number {
  if (
    !ISO_CURRENCY.test(currency) ||
    !Intl.supportedValuesOf('currency').includes(currency)
  ) {
    throw new TypeError(`Unsupported ISO 4217 currency: ${currency}`);
  }

  const digits = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined)
    throw new TypeError(`Currency precision is unavailable: ${currency}`);
  return digits;
}

export function minorToDecimal(amountMinor: bigint, currency: string): string {
  if (amountMinor < 0n) throw new RangeError('Amount cannot be negative');

  const digits = fractionDigits(currency);
  if (digits === 0) return amountMinor.toString();

  const scale = 10n ** BigInt(digits);
  const whole = amountMinor / scale;
  const fraction = (amountMinor % scale).toString().padStart(digits, '0');
  return `${whole}.${fraction}`;
}

export function decimalToMinor(amount: string, currency: string): bigint {
  const digits = fractionDigits(currency);
  const match = DECIMAL_AMOUNT.exec(amount);
  const whole = match?.[1];
  if (whole === undefined)
    throw new TypeError('Amount must be a non-negative decimal string');

  const fraction = match?.[2] ?? '';
  if (fraction.length > digits)
    throw new RangeError('Amount has more precision than its currency allows');

  const scale = 10n ** BigInt(digits);
  const wholeMinor = BigInt(whole) * scale;
  if (digits === 0) return wholeMinor;

  return wholeMinor + BigInt(fraction.padEnd(digits, '0') || '0');
}
