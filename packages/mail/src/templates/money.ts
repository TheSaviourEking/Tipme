// BigInt all the way: Intl formats a bigint exactly, so no amount passes through a float.
const grouped = (whole: bigint) => new Intl.NumberFormat('en').format(whole);

/** "NGN 4,500.00" from minor units (a decimal string). */
export const ngn = (minor: string) => {
  const value = BigInt(minor);
  return `NGN ${grouped(value / 100n)}.${String(value % 100n).padStart(2, '0')}`;
};

/** "₦4,500" from minor units, or "₦4,050.50" when the kobo are not zero. Never truncated. */
export const naira = (minor: string) => {
  const value = BigInt(minor);
  const kobo = value % 100n;
  return `₦${grouped(value / 100n)}${kobo === 0n ? '' : `.${String(kobo).padStart(2, '0')}`}`;
};

/** Kept for subjects written before `naira`; it no longer drops the kobo. */
export const nairaWhole = naira;
