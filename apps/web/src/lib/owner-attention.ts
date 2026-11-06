import type { BachsPaymentAccountStatus, MyProfile } from '@tipme/contracts';

export type AttentionItem = {
  id:
    | 'verify_email'
    | 'set_up_payments'
    | 'finish_payments'
    | 'payments_checking'
    | 'page_offline'
    | 'add_recovery_email';
  title: string;
  body: string;
  /** The one step that fixes it; absent while TipMe is the one checking. */
  action?: { href: string; label: string };
  /** The dashboard tab that leads to the fix, marked so it is noticed from any page. */
  navHref: string;
};

const SETTINGS = '/dashboard/settings';

// The provider's name for a bank account still due. Recipients add it on the Get paid card, where
// it takes an email code, so it is never sent to the hosted page and never shown as this word.
const BANK_ACCOUNT_REQUIREMENT = 'payout_destination';

export const needsBankAccount = (requirementsDue: readonly string[]) =>
  requirementsDue.includes(BANK_ACCOUNT_REQUIREMENT);

/** What the payment account's own setup still wants, without the bank account. */
export const onboardingRequirements = (requirementsDue: readonly string[]) =>
  requirementsDue.filter((item) => item !== BANK_ACCOUNT_REQUIREMENT);

const REQUIREMENT_WORDS: readonly (readonly [RegExp, string])[] = [
  // First: a business has a name and an address too, and they aren't the person's.
  [/business|company/i, 'business details'],
  [/id_number|national_id|\bnin\b|\bbvn\b/i, 'your ID number'],
  [/document|verification|selfie/i, 'your ID document'],
  [/dob|birth/i, 'your date of birth'],
  [/name/i, 'your name'],
  [/address/i, 'your address'],
  [/phone/i, 'your phone number'],
  [/email/i, 'your email'],
  [/tos|terms|agreement/i, 'accepting the terms'],
];

/** What setup still wants, in words: the provider's field names are never shown. */
export const requirementWords = (requirementsDue: readonly string[]) => [
  ...new Set(
    onboardingRequirements(requirementsDue).map(
      (item) =>
        REQUIREMENT_WORDS.find(([pattern]) => pattern.test(item))?.[1] ??
        'other details',
    ),
  ),
];

/**
 * Everything that stops the owner earning, most urgent first, in their words. Owners otherwise
 * find out only when a supporter is turned away ("Not sent yet"), which they never see.
 */
export function ownerAttention({
  profile,
  payments,
  needsRecoveryEmail = false,
}: {
  profile: Pick<MyProfile, 'emailVerified' | 'pageState' | 'suspended'>;
  payments: Pick<
    BachsPaymentAccountStatus,
    'enabled' | 'status' | 'chargesEnabled' | 'requirementsDue'
  > | null;
  needsRecoveryEmail?: boolean;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  // Without a payment provider that needs setup (test payments), or when the account could
  // not be read, there is nothing true to say about payments.
  if (payments?.enabled) {
    const { status } = payments;
    if (status === 'CREATING' || status === 'UNKNOWN')
      items.push({
        id: 'payments_checking',
        title: 'We’re checking your payment account',
        body: 'Supporters can’t tip you until it’s confirmed. TipMe will check it for you, so there’s no need to start again.',
        navHref: SETTINGS,
      });
    else if (status === null || status === 'FAILED')
      items.push(
        profile.emailVerified
          ? {
              id: 'set_up_payments',
              title: 'Set up payments to start receiving tips',
              body: 'Supporters can’t tip you until this is done. It takes a few minutes.',
              action: {
                href: `${SETTINGS}#payments`,
                label: 'Set up payments',
              },
              navHref: SETTINGS,
            }
          : {
              id: 'verify_email',
              title: 'Confirm your email to set up payments',
              body: 'Supporters can’t tip you until payments are set up, and that starts with a confirmed email.',
              action: { href: `${SETTINGS}#contact`, label: 'Confirm email' },
              navHref: SETTINGS,
            },
      );
    else if (!(status === 'ACTIVE' && payments.chargesEnabled)) {
      const left = onboardingRequirements(payments.requirementsDue).length;
      items.push({
        id: 'finish_payments',
        title: 'Finish setting up payments',
        body:
          left > 0
            ? `Supporters can’t tip you yet. Your payment account needs ${left} more ${left === 1 ? 'detail' : 'details'}.`
            : needsBankAccount(payments.requirementsDue)
              ? 'Your payment account still needs the bank account you want to be paid to.'
              : 'Supporters can’t tip you until your payment account is complete.',
        action:
          left === 0 && needsBankAccount(payments.requirementsDue)
            ? { href: `${SETTINGS}#get-paid`, label: 'Add your bank account' }
            : { href: `${SETTINGS}#payments`, label: 'Continue setup' },
        navHref: SETTINGS,
      });
    }
  }
  if (profile.pageState === 'not_live' && !profile.suspended)
    items.push({
      id: 'page_offline',
      title: 'Your page is offline',
      body: 'Supporters can’t find you or tip you until you make it live.',
      action: { href: `${SETTINGS}#page`, label: 'Make my page live' },
      navHref: SETTINGS,
    });
  // Last: it protects the account, but nothing is stopping tips.
  if (needsRecoveryEmail)
    items.push({
      id: 'add_recovery_email',
      title: 'Add a recovery email',
      body: 'So you can get back in if you lose access to your email.',
      action: { href: `${SETTINGS}#recovery`, label: 'Add recovery email' },
      navHref: SETTINGS,
    });
  return items;
}

/** Whether this notice is about taking payments, not the page or the account. */
export const isPaymentAttention = (item: AttentionItem) =>
  item.id !== 'page_offline' && item.id !== 'add_recovery_email';

/**
 * The reminders this page shows (WithdrawRedesign, "What changes"). The recovery-email one shows
 * on Home and Settings only: it protects the account, but nothing is stopping tips. Every other
 * item stops the owner earning, so it shows everywhere. The nav dots keep the full list.
 */
export function attentionHere(
  items: AttentionItem[] | null,
  pathname: string,
): AttentionItem[] | null {
  if (items === null) return null;
  const home =
    pathname === '/dashboard' ||
    pathname === SETTINGS ||
    pathname.startsWith(`${SETTINGS}/`);
  return home
    ? items
    : items.filter((item) => item.id !== 'add_recovery_email');
}

/** Fired after the recovery email changes, so the reminders update without navigating. */
export const RECOVERY_EMAIL_CHANGED = 'tipme:recovery-email-changed';
