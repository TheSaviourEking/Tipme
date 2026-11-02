export function formatDemoAmount(minor: number): string {
  const digits = String(minor).padStart(3, '0');
  return `NGN ${new Intl.NumberFormat('en').format(Number(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}

/** For a label with little room: ₦2,000, or ₦2,500.50 when there are kobo. */
export function formatNaira(minor: number): string {
  const kobo = minor % 100;
  const naira = new Intl.NumberFormat('en').format((minor - kobo) / 100);
  return kobo ? `₦${naira}.${String(kobo).padStart(2, '0')}` : `₦${naira}`;
}
