/**
 * The partner's fee for one NGN payout, as quoted to the user before they withdraw (owner, 14 Nov
 * 2026): ₦50 today, from the partner's published default. The one place it is set; the pretend
 * provider quotes the same. The user pays the partner's actual fee: a different one is settled on
 * their balance when the payout is paid.
 */
export const NGN_PAYOUT_FEE_MINOR = 5000n;
