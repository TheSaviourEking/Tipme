export function formatDemoAmount(minor: number): string {
  const digits = String(minor).padStart(3, '0');
  return `NGN ${new Intl.NumberFormat('en').format(Number(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}
