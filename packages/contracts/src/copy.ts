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

/**
 * The recipient's words for what TipMe holds for them (spec §10; RM7 adds `refundHeld`). User
 * copy: never names the payment partner.
 */
export const COLLECT_HELD_WORDS = {
  kept: 'Kept for you until you add your bank details',
  onItsWay: 'On its way to you',
  refundHeld: 'Held while a refund is settled',
} as const;

/**
 * Home's note under the balance (owner, 22 Nov 2026, R5-M2): refund-held money is not in "Your
 * balance", so it is said on its own, below it, only while there is some. The amount is put in
 * already formatted (₦3,000).
 */
export const COLLECT_HELD_NOTE = {
  refundHeld: (amount: string) =>
    `${amount} is held while a refund is settled.`,
} as const;

/**
 * Withdraw for a verified You collect recipient with nothing to withdraw (owner, 23 Nov 2026;
 * ADR-0016): each tip's share moves to their own account and can be withdrawn once it arrives, so
 * nothing here says it goes straight to their bank. The bank and hours are put in already formatted
 * (Opay ••5629; 24 hours). Never the partner's name.
 */
export const COLLECT_WITHDRAW_WORDS = {
  thenWithdraw: 'You can withdraw it once it arrives.',
  bank: (bank: string) => `Withdrawals go to ${bank}`,
  newAccountDelay: (hours: string) =>
    `New accounts’ tips arrive ${hours} after they’re received.`,
} as const;

/**
 * The in-app notice after support changes a recipient's verified name (Task 15 fix round 1, I3):
 * their tips wait until our payment partner checks the new name with their bank details again.
 */
export const COLLECT_NAME_RECHECK_NOTICE = {
  title: 'Add your bank details again',
  body: 'Your verified name was changed. Add your bank details again so our payment partner can check the new name and send your tips.',
  /** Above the bank form on Withdraw and Get paid while they add it again (fix round 2). */
  formLine:
    'Your name was updated. Add your bank details again so we can check it.',
} as const;

/**
 * One balance across providers (per-provider balances, spec §6): the words beside a usable
 * withdrawal form when part of the balance can't go now, and for a request paid as more than one
 * payment. Amounts and states only: never a provider's name, never the payment partner's.
 */
export const WITHDRAW_SPLIT_COPY = {
  partialTitle: 'Some of your balance is on hold',
  partial:
    'Some of your balance can’t be withdrawn right now. Try again later.',
  bankTitle: 'Bank details needed',
  bank: 'Add your bank details again to withdraw all of your balance.',
  bankLink: 'Go to Get paid',
  heldTitle: 'Some tips can’t be paid out yet',
  held: 'Some of your tips were paid in a way TipMe can’t pay out from yet. Your tips are safe, and your balance stays here until withdrawals open.',
  mayArrive: (n: number) => `This may arrive as ${n} payments.`,
  partlySent: 'Partly sent',
  part: {
    sent: 'sent',
    onItsWay: 'on its way',
    reversed: 'reversed',
  },
} as const;

/**
 * A person's first withdrawal (owner, 26 Nov 2026): their first time on our payment partner's identity
 * check, and the first payout then takes hours. Never a provider's name: always "our payment partner".
 * A business's Money section doesn't use these.
 */
export const FIRST_WITHDRAWAL_COPY = {
  setupTitle: 'Confirm who you are',
  setupBody:
    'Before your first withdrawal, our payment partner needs to confirm who you are. You’ll finish this on their page; it takes a few minutes. Your first withdrawal can then take a few hours.',
  setupLink: 'Continue to verify',
  /** Before confirming the first withdrawal. */
  beforeConfirm:
    'Your first withdrawal can take a few hours. After that, they’re usually quicker.',
  /** On a first withdrawal's row while it is still processing. */
  processing: 'First withdrawals can take a few hours.',
} as const;

/**
 * The same notices on a business's Money section (Task 9 fix round 1), in the business's words.
 * Never a provider's name, never the payment partner's.
 */
export const BUSINESS_SPLIT_COPY = {
  partialTitle: 'Some of the business’s balance is on hold',
  partial:
    'Some of the business’s balance can’t be withdrawn right now. Try again later.',
  bankTitle: 'Bank details needed',
  bank: 'Add the business’s bank details again to withdraw all of its balance.',
  bankLink: 'Add bank details again',
  heldTitle: 'Some tips can’t be paid out yet',
  held: 'Some of the business’s tips were paid in a way TipMe can’t pay out from yet. They’re safe, and stay in the business’s balance until withdrawals open.',
} as const;
