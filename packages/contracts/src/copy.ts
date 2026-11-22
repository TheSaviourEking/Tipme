/*
 * Client-safe copy, exported on its own as `@tipme/contracts/copy`: no imports at all, so a public
 * page can use these words without shipping the contracts barrel (its zod schemas). The barrel
 * re-exports them too. apps/web/test/contracts-client-imports.test.mjs keeps both true.
 */

/**
 * The words a recipient and their supporters read about You collect: spec §10, word for word
 * (apps/web/test/collect-copy.test.mjs reads the spec's table against these). Never the partner's
 * name, and nothing that implies a wallet, a licence or a bank. The amounts and dates are put in
 * already formatted (₦50,000; 21 December).
 */
export const COLLECT_COPY = {
  dashboardNoBank:
    'You can take tips now. Add your bank details when you want to withdraw.',
  balanceNote: 'Kept for you until you add your bank details.',
  withdrawNoBank: 'Add bank details to withdraw',
  withdrawOwnName: 'Use a bank account in your own name.',
  nameHint: 'Use the name on your bank account.',
  firstNameMissing: 'Enter your first name.',
  lastNameMissing: 'Enter your last name.',
  findingAccount: 'Finding your account…',
  accountNotFound:
    'We couldn’t find this account. Check the bank and account number.',
  nameConfirm: (bankName: string) => `Is this you? ${bankName}`,
  checking: 'We’re checking your details. This usually takes a few minutes.',
  manualCheck: 'We’re checking this by hand. We’ll tell you when it’s done.',
  nameMismatch: 'This account isn’t in your name. Use one that is.',
  verified: 'You’re all set. Your tips are on their way to you.',
  onItsWay: 'On its way to you',
  reminder: (amount: string) =>
    `You have ${amount} in tips waiting. Add your bank details to withdraw it.`,
  reminderLast: (date: string) =>
    `Add your bank details by ${date}, or your page will pause new tips.`,
  pausedRecipient:
    'Your page has paused tips. Add your bank details to start taking tips again.',
  pausedSupporter: (name: string) =>
    `${name} can’t take tips right now. Please try again later.`,
  receipt: (name: string) => `Paid to TipMe for ${name}`,
  firstWithdrawalCap: (amount: string) =>
    `New accounts can withdraw up to ${amount} the first time.`,
  disputeHold: (amount: string) =>
    `A payment to you is being questioned. We’ve held ${amount} until it’s settled.`,
} as const;
