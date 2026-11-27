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

/**
 * Fee waivers (spec 2026-11-23 §6, §7; W13, ruling R22): the in-app notices an account gets when TipMe
 * starts or stops paying one of its fees. An account waiver is told when it starts and when TipMe
 * stops paying that fee; a kind-wide waiver's start is told to nobody, and its end to each account
 * that used its cover. An ended notice names the fee that ended, so it is never false while TipMe
 * still pays the other one. `until` is put in already worded by `untilWords` ("until 31 Jan": the
 * last Lagos day covered). Never the payment partner's name.
 */
export const FEE_WAIVER_NOTICE_COPY = {
  startedTitle: 'TipMe is covering your fees',
  /** A business's notice names it: its owners may have pages of their own. */
  startedTitleFor: (business: string) => `TipMe is covering ${business}’s fees`,
  started: (fee: 'tip' | 'withdrawal', until: string | null) =>
    `${fee === 'tip' ? 'TipMe is covering the fee on your tips' : 'TipMe is covering your withdrawal fees'}${until === null ? '' : ` ${until}`}`,
  endedTitle: (fee: 'tip' | 'withdrawal') =>
    fee === 'tip'
      ? 'Your tip fee cover has ended'
      : 'Your withdrawal fee cover has ended',
  endedTitleFor: (business: string, fee: 'tip' | 'withdrawal') =>
    `${business}’s ${fee === 'tip' ? 'tip' : 'withdrawal'} fee cover has ended`,
  ended: (fee: 'tip' | 'withdrawal') =>
    fee === 'tip'
      ? 'TipMe has stopped covering the fee on your tips. The normal tip fee applies from now.'
      : 'TipMe has stopped covering your withdrawal fees. The normal withdrawal fees apply from now.',
} as const;

/**
 * Fee waivers (spec 2026-11-23 §7, W17): what a recipient reads while TipMe pays a fee. The
 * dashboard line is said only while a new tip would be waived; the tip's own line is past tense,
 * from what its quote recorded. `until` comes in worded by `untilWords` ("until 31 Jan"). Never the
 * payment partner's name.
 */
export const FEE_WAIVER_RECIPIENT_COPY = {
  /** The started notice's words, so the notice and the dashboard never drift apart. */
  tipsCovered: (until: string | null) =>
    FEE_WAIVER_NOTICE_COPY.started('tip', until),
  tipCovered: 'TipMe covered the fee on this tip.',
  /** A business's Money section, while TipMe pays its transfer fee; the amount follows. */
  businessTransferFree: 'Transfer fee: Free.',
  businessReceives: 'The business receives',
} as const;

/**
 * Who pays the fees, for staff (spec 2026-11-23 §6): the grid on Fees, its change dialog, the
 * Waivers list and the per-account control. Dates come in already worded by `untilWords` ("until 31
 * Jan"), amounts already formatted (₦12,350). These words reach components the provider-name rule
 * covers, so they say "the payment partner", never its name.
 */
export const FEE_WAIVER_STAFF_COPY = {
  title: 'Who pays the fees',
  hint: 'Today’s rules apply until staff set a waiver. A change applies to new tips and withdrawals only: a price already shown keeps its terms.',
  kinds: {
    individual: 'Individuals',
    business: 'Businesses',
    giving: 'Giving',
  },
  /** Giving isn't built: its rules are stored, and nothing reads them yet. */
  notLive: '(not live)',
  fees: { tip: 'Tip fee', withdrawal: 'Withdrawal fee' },
  monthCost: 'Cost so far this month',
  accountPays: 'Account pays',
  tipmePays: (until: string | null) =>
    until === null ? 'TipMe pays' : `TipMe pays · ${until}`,
  /**
   * A person's withdrawal fee under today's rule. Kept here alone: the profit-guards branch changes
   * the rule and this line with it (R17).
   */
  individualWithdrawalDefault: '2 free a day, then account',
  /** Businesses have no tip fee (spec §2). */
  noFee: '—',
  incomeGivenUp: 'Fee income given up',
  cashPaid: 'Cash paid by TipMe',
  paused: 'Paused (low balance)',
  pausedTitle: 'Tip fee waivers paused',
  pausedBody:
    'TipMe’s balance at the payment partner is low, so new tips are priced normally until it recovers. Tips already priced keep their terms. Fund the balance before approving a kind-wide tip waiver.',
  /** A grid cell's change set to start later: "From 1 Dec: TipMe pays · until 12 Dec". */
  upcomingChange: (from: string, words: string) =>
    `${from.charAt(0).toUpperCase()}${from.slice(1)}: ${words}`,
  seeAll: 'See every waiver',
  change: 'Change…',
  waiting: (count: number) =>
    count === 1
      ? 'A change is waiting in Approvals. Who pays hasn’t changed yet.'
      : `${count} changes are waiting in Approvals. Who pays hasn’t changed yet.`,

  // The change dialog (kind-wide).
  dialogTitle: 'Change who pays',
  forLabel: 'Who it’s for',
  feeLabel: 'Fee',
  businessTipNote:
    'Businesses have no tip fee: their staff’s own pages carry it.',
  payerLegend: 'Who pays',
  tipmePaysChoice: 'TipMe pays',
  tipmePaysHint:
    'The account keeps the whole tip, or pays no withdrawal fee. TipMe pays the partner’s fee itself.',
  normalChoice: 'Normal rules',
  normalHint: 'Today’s fees. Choosing this ends a waiver.',
  startLabel: 'First day (optional)',
  startHint: 'Lagos time. Leave it empty to start once approved.',
  endLabel: 'Last day (optional)',
  endHint:
    'The last day this applies, Lagos time. Leave it empty for no end. Up to 24 months ahead.',
  reasonLabel: 'Reason',
  reasonHint: 'Recorded in the audit log with your name and the time.',
  submit: 'Ask for approval',
  cancel: 'Cancel',
  monthlyCostTitle: 'What it would cost',
  confirmCost: (amount: string) =>
    `TipMe would pay about ${amount} a month, from the last 30 days’ fees. Tick the box to confirm it.`,
  estimateMoved: (amount: string) =>
    `The estimate changed to ${amount} since you opened this. Check it and confirm again.`,
  confirmBox: (amount: string) =>
    `I confirm TipMe pays about ${amount} a month`,
  confirmMissing: 'Tick the box to confirm the cost.',
  reasonShort: 'Please write a reason of at least 10 characters.',
  endBeforeStart: 'The last day can’t be before the first day.',
  endPast: 'The last day can’t be in the past.',
  startPast: 'The first day can’t be in the past.',
  outOfBounds:
    'Check the dates: the last day must be after the first, and within 24 months.',
  done: 'Who pays has changed, for new tips and withdrawals.',
  meanwhile: 'Who pays stays the same until then.',

  // The Waivers list.
  listTitle: 'Fee waivers',
  listHint:
    'Every rule in force or upcoming: who it is for, when it ends, who set and approved it, and what it has cost so far. Rows are never edited: a change is a new row.',
  backToFees: '← Fees',
  inForce: 'In force',
  upcoming: 'Upcoming',
  noneInForce: 'No waivers in force',
  noneUpcoming: 'Nothing upcoming',
  noneUpcomingBody: 'No change is set to start later.',
  columns: {
    who: 'For',
    fee: 'Fee',
    payer: 'Who pays',
    starts: 'Starts',
    ends: 'Ends',
    setBy: 'Set by',
    approvedBy: 'Approved by',
    cost: 'Cost so far',
    reason: 'Reason',
  },
  allOf: {
    individual: 'All individuals',
    business: 'All businesses',
    giving: 'All Giving accounts',
  },
  unknownAccount: 'An account no longer found',
  noEnd: 'No end date',
  /** An account's own `account` row: it keeps the normal rules while its kind is waived. */
  optedOut: 'Normal rules (opted out)',
  /** A row that only ends a waiver: an account's `inherit`, a kind-wide `account`. */
  endsWaiver: 'Ends the waiver',
  carriedOver: 'Carried over from the switch',
  alone: 'Alone (no second person)',

  // The per-account control.
  followGlobalNow: (now: string) => `Follows the global setting (now: ${now})`,
  normalOwn: 'Normal rules, whatever the global setting',
  accountChoices: {
    inherit: 'Follow the global setting',
    tipme: 'TipMe pays',
    account: 'Normal rules',
  },
  accountHints: {
    inherit: 'Whatever is set for all accounts of this kind on Fees.',
    tipme: 'TipMe pays this fee for this account.',
    account: 'Today’s fees, even while its kind is waived.',
  },
  changeFee: (fee: 'tip' | 'withdrawal') =>
    `Change the ${fee === 'tip' ? 'tip' : 'withdrawal'} fee…`,
  thisMonth: 'This month',
  sameSetting: 'Choose a setting different from the one in use now.',
} as const;
