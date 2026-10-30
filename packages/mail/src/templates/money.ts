const whole = (minor: bigint) =>
  new Intl.NumberFormat('en').format(Number(minor / 100n));

/** "NGN 4,500.00" from minor units (a decimal string). */
export const ngn = (minor: string) => {
  const value = BigInt(minor);
  return `NGN ${whole(value)}.${String(value % 100n).padStart(2, '0')}`;
};

/** "₦4,500" from minor units, for subjects. */
export const nairaWhole = (minor: string) => `₦${whole(BigInt(minor))}`;
