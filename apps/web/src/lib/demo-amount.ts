export function formatDemoAmount(minor: number): string {
  const digits = String(minor).padStart(3, '0');
  return `NGN ${new Intl.NumberFormat('en').format(Number(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}

/**
 * The one way an amount of naira is written for a recipient or a supporter: ₦2,000, or ₦2,500.50
 * when there are kobo. Takes minor units as the API's decimal string, a number or a bigint, and
 * counts in BigInt so a large balance never loses a digit. ISO-code amounts (NGN 2,000.00) stay
 * only where a code is wanted: the mock checkout, the CSV and the staff console (formatDemoAmount).
 */
export function formatNaira(minor: string | number | bigint): string {
  // The web app targets ES2017 (no BigInt literals), hence BigInt(100).
  const hundred = BigInt(100);
  const value = BigInt(minor);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const kobo = Number(abs % hundred);
  const whole = new Intl.NumberFormat('en').format(abs / hundred);
  return `${negative ? '−' : ''}₦${whole}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;
}
